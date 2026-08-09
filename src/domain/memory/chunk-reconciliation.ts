import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { chunks } from "@/db/schema";
import { decryptJson, encryptJson } from "@/domain/crypto/encrypted-json";
import type { ChunkMemoryPayload } from "@/domain/memory/extractor";
import { chunkTurns } from "@/domain/memory/chunker";

const EMPTY_VECTOR = Array<number>(1536).fill(0);

export type ChunkBoundaryTurn = {
  id: string;
  startedAt: Date;
  endedAt: Date;
};

export type StoredChunkPartition = {
  id: string;
  startTurnId: string;
  endTurnId: string;
  startedAt: Date;
  endedAt: Date;
  encryptedSummary: string;
};

export type ChunkPartitionWrite = Omit<StoredChunkPartition, "id">;

export interface ChunkReconciliationRepository {
  listChunks(roomId: string): Promise<StoredChunkPartition[]>;
  insertChunk(roomId: string, chunk: ChunkPartitionWrite): Promise<void>;
  updateChunk(roomId: string, chunkId: string, chunk: ChunkPartitionWrite): Promise<void>;
  deleteChunks(roomId: string, chunkIds: string[]): Promise<void>;
}

type TurnRange = { start: number; end: number };

function turnIndex(turns: ChunkBoundaryTurn[]): Map<string, number> {
  return new Map(turns.map((turn, index) => [turn.id, index]));
}

function rangeForChunk(chunk: Pick<StoredChunkPartition, "startTurnId" | "endTurnId">, indexes: Map<string, number>): TurnRange | null {
  const start = indexes.get(chunk.startTurnId);
  const end = indexes.get(chunk.endTurnId);
  return start === undefined || end === undefined || start > end ? null : { start, end };
}

function overlap(left: TurnRange, right: TurnRange): number {
  return Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start) + 1);
}

function analysisKeys(encryptedSummary: string): string[] {
  const payload = decryptJson<Partial<ChunkMemoryPayload> | string>(encryptedSummary);
  if (typeof payload === "string") return [];
  return [...new Set([
    ...(payload.analysisKey ? [payload.analysisKey] : []),
    ...(payload.previousAnalysisKeys ?? []),
  ].filter(Boolean))];
}

function summaryWithPreviousKeys(encryptedSummary: string, previousAnalysisKeys: string[]): string {
  if (previousAnalysisKeys.length === 0) return encryptedSummary;
  const payload = decryptJson<Partial<ChunkMemoryPayload> | string>(encryptedSummary);
  if (typeof payload === "string") {
    return encryptJson({
      summary: payload,
      analysisComplete: false,
      previousAnalysisKeys,
    });
  }
  return encryptJson({
    ...payload,
    previousAnalysisKeys: [...new Set([
      ...(payload.previousAnalysisKeys ?? []),
      ...previousAnalysisKeys,
    ])],
  });
}

function emptySummary(previousAnalysisKeys: string[] = []): string {
  return encryptJson({
    analysisComplete: false,
    ...(previousAnalysisKeys.length > 0 ? { previousAnalysisKeys } : {}),
  });
}

export function chunksCoverTurnsExactlyOnce(
  turns: ChunkBoundaryTurn[],
  storedChunks: Array<Pick<StoredChunkPartition, "startTurnId" | "endTurnId">>,
): boolean {
  if (turns.length === 0) return storedChunks.length === 0;
  const indexes = turnIndex(turns);
  const coverage = Array<number>(turns.length).fill(0);
  for (const chunk of storedChunks) {
    const range = rangeForChunk(chunk, indexes);
    if (!range) return false;
    for (let index = range.start; index <= range.end; index += 1) coverage[index]! += 1;
  }
  return coverage.every((count) => count === 1);
}

/**
 * Reconciles deterministic time partitions while retaining stable chunk IDs.
 * Any removed partition's analysis lineage is transferred to one overlapping
 * replacement so profile cleanup happens in the same extraction transaction.
 */
export async function reconcileRoomChunks(
  roomId: string,
  turns: ChunkBoundaryTurn[],
  repository: ChunkReconciliationRepository,
): Promise<void> {
  const existing = (await repository.listChunks(roomId))
    .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime() || left.id.localeCompare(right.id));
  const indexes = turnIndex(turns);
  const plans = chunkTurns(turns.map((turn) => ({ ...turn, speaker: "", messages: [] })), []).map((chunk) => ({
    range: { start: chunk.startTurnIndex, end: chunk.endTurnIndex },
    startTurnId: turns[chunk.startTurnIndex]!.id,
    endTurnId: turns[chunk.endTurnIndex]!.id,
    startedAt: chunk.startedAt,
    endedAt: chunk.endedAt,
  }));
  const available = new Set(existing.map((chunk) => chunk.id));
  const matches = new Map<number, StoredChunkPartition>();

  const choose = (planIndex: number, predicate: (chunk: StoredChunkPartition) => boolean) => {
    const match = existing.find((chunk) => available.has(chunk.id) && predicate(chunk));
    if (!match) return false;
    matches.set(planIndex, match);
    available.delete(match.id);
    return true;
  };

  plans.forEach((plan, planIndex) => {
    choose(planIndex, (chunk) => chunk.startTurnId === plan.startTurnId && chunk.endTurnId === plan.endTurnId);
  });
  plans.forEach((plan, planIndex) => {
    if (matches.has(planIndex)) return;
    choose(planIndex, (chunk) => chunk.startTurnId === plan.startTurnId);
  });
  plans.forEach((plan, planIndex) => {
    if (matches.has(planIndex)) return;
    choose(planIndex, (chunk) => chunk.endTurnId === plan.endTurnId);
  });
  plans.forEach((plan, planIndex) => {
    if (matches.has(planIndex)) return;
    const candidates = existing
      .filter((chunk) => available.has(chunk.id))
      .map((chunk) => ({ chunk, range: rangeForChunk(chunk, indexes) }))
      .filter((entry): entry is { chunk: StoredChunkPartition; range: TurnRange } => entry.range !== null)
      .map((entry) => ({ ...entry, overlap: overlap(plan.range, entry.range) }))
      .filter((entry) => entry.overlap > 0)
      .sort((left, right) => right.overlap - left.overlap || left.chunk.id.localeCompare(right.chunk.id));
    const best = candidates[0]?.chunk;
    if (best) {
      matches.set(planIndex, best);
      available.delete(best.id);
    }
  });

  const inheritedKeys = new Map<number, string[]>();
  for (const obsolete of existing.filter((chunk) => available.has(chunk.id))) {
    const obsoleteRange = rangeForChunk(obsolete, indexes);
    if (!obsoleteRange) continue;
    const owner = plans.map((plan, planIndex) => ({
      planIndex,
      overlap: overlap(plan.range, obsoleteRange),
    })).sort((left, right) => right.overlap - left.overlap || left.planIndex - right.planIndex)[0];
    if (!owner || owner.overlap === 0) continue;
    inheritedKeys.set(owner.planIndex, [
      ...(inheritedKeys.get(owner.planIndex) ?? []),
      ...analysisKeys(obsolete.encryptedSummary),
    ]);
  }

  for (const [planIndex, plan] of plans.entries()) {
    const match = matches.get(planIndex);
    const previousAnalysisKeys = [...new Set(inheritedKeys.get(planIndex) ?? [])];
    const write: ChunkPartitionWrite = {
      startTurnId: plan.startTurnId,
      endTurnId: plan.endTurnId,
      startedAt: plan.startedAt,
      endedAt: plan.endedAt,
      encryptedSummary: match
        ? summaryWithPreviousKeys(match.encryptedSummary, previousAnalysisKeys)
        : emptySummary(previousAnalysisKeys),
    };
    if (match) await repository.updateChunk(roomId, match.id, write);
    else await repository.insertChunk(roomId, write);
  }
  await repository.deleteChunks(roomId, [...available]);
}

type DrizzleExecutor = Pick<NodePgDatabase<typeof import("@/db/schema")>, "select" | "insert" | "update" | "delete">;

export function createDrizzleChunkReconciliationRepository(
  database: NodePgDatabase<typeof import("@/db/schema")>,
): ChunkReconciliationRepository {
  const executor = database as DrizzleExecutor;
  return {
    async listChunks(roomId) {
      return executor.select({
        id: chunks.id,
        startTurnId: chunks.startTurnId,
        endTurnId: chunks.endTurnId,
        startedAt: chunks.startedAt,
        endedAt: chunks.endedAt,
        encryptedSummary: chunks.encryptedSummary,
      }).from(chunks).where(eq(chunks.roomId, roomId));
    },
    async insertChunk(roomId, chunk) {
      await executor.insert(chunks).values({
        roomId,
        ...chunk,
        encryptedTopicTags: encryptJson<string[]>([]),
        encryptedEventTypes: encryptJson<string[]>([]),
        embedding: EMPTY_VECTOR,
      });
    },
    async updateChunk(roomId, chunkId, chunk) {
      await executor.update(chunks).set({ ...chunk, updatedAt: new Date() })
        .where(and(eq(chunks.roomId, roomId), eq(chunks.id, chunkId)));
    },
    async deleteChunks(roomId, chunkIds) {
      if (chunkIds.length === 0) return;
      await executor.delete(chunks).where(and(eq(chunks.roomId, roomId), inArray(chunks.id, chunkIds)));
    },
  };
}
