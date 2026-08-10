import { asc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { withDedicatedDatabase } from "@/db/client";
import { chunks, turns } from "@/db/schema";
import { safeLog } from "@/lib/logger";
import {
  classifyAnalysisFailure,
  createDrizzleAnalysisProgressRepository,
  type AnalysisProgress,
} from "./analysis-progress";
import {
  applyRoomFinalization,
  createDrizzleMemoryRepository,
  planRoomFinalization,
  prepareRoomChunks,
  type RoomMemoryResult,
} from "./extractor";
import {
  chunksCoverTurnsExactlyOnce,
  createDrizzleChunkReconciliationRepository,
  reconcileRoomChunks,
} from "./chunk-reconciliation";
import {
  createDrizzleProfileRepository,
  createTransactionBoundDrizzleProfileRepository,
} from "@/domain/profiles/profile-service";
import { OpenAIModelGateway } from "@/domain/models/openai-gateway";

type Database = NodePgDatabase<typeof import("@/db/schema")>;
type ScalarLog = (event: string, metadata: Record<string, string | number | boolean>) => void;

export type RoomAnalysisOperations = {
  reconcile(): Promise<number>;
  prepare(onPrepared: (completed: number) => Promise<void>): Promise<void>;
  plan(): Promise<unknown>;
  apply(plan: unknown): Promise<RoomMemoryResult>;
  progress: ReturnType<typeof createDrizzleAnalysisProgressRepository>;
  log: ScalarLog;
};

function providerStatus(error: unknown): number {
  if (typeof error !== "object" || error === null || !("status" in error)) return 0;
  return typeof error.status === "number" ? error.status : 0;
}

/** Pure stage coordinator used by production and deterministic integration tests. */
export async function runRoomAnalysis(
  roomId: string,
  operations: RoomAnalysisOperations,
): Promise<RoomMemoryResult> {
  let stage: AnalysisProgress["stage"] = "chunks";
  let completedChunks = 0;
  let totalChunks = 0;
  let started = false;
  try {
    totalChunks = await operations.reconcile();
    await operations.progress.start(roomId, totalChunks);
    started = true;
    const prior = await operations.progress.get(roomId);
    completedChunks = prior?.completedChunks ?? 0;
    await operations.prepare(async (completed) => {
      completedChunks = completed;
      await operations.progress.recordChunk(roomId, completed);
    });
    stage = "hierarchy";
    await operations.progress.finalizing(roomId, stage);
    const plan = await operations.plan();
    stage = "profiles";
    await operations.progress.finalizing(roomId, stage);
    const result = await operations.apply(plan);
    await operations.progress.ready(roomId);
    return result;
  } catch (error) {
    const failure = classifyAnalysisFailure(error);
    if (started) await operations.progress.failed(roomId, failure);
    operations.log("room_analysis_failed", {
      roomId,
      stage,
      completedChunks,
      totalChunks,
      failure,
      providerStatus: providerStatus(error),
    });
    throw error;
  }
}

export async function withRoomAnalysisLock<T>(
  database: Pick<Database, "execute">,
  roomId: string,
  work: () => Promise<T>,
): Promise<T> {
  await database.execute(sql`select pg_advisory_lock(hashtext(${roomId}))`);
  try {
    return await work();
  } finally {
    await database.execute(sql`select pg_advisory_unlock(hashtext(${roomId}))`);
  }
}

function productionOperations(roomId: string, database: Database): RoomAnalysisOperations {
  const gateway = new OpenAIModelGateway();
  const progress = createDrizzleAnalysisProgressRepository(database);
  return {
    progress,
    log: safeLog,
    async reconcile() {
      return database.transaction(async (transaction) => {
        const storedTurns = await transaction.select({
          id: turns.id,
          startedAt: turns.startedAt,
          endedAt: turns.endedAt,
        }).from(turns).where(eq(turns.roomId, roomId)).orderBy(asc(turns.startedAt), asc(turns.id));
        const repository = createDrizzleChunkReconciliationRepository(transaction);
        await reconcileRoomChunks(roomId, storedTurns, repository);
        const reconciled = await repository.listChunks(roomId);
        if (!chunksCoverTurnsExactlyOnce(storedTurns, reconciled)) {
          throw new Error("Room chunks do not cover every turn exactly once");
        }
        return reconciled.length;
      });
    },
    async prepare(onPrepared) {
      await prepareRoomChunks(roomId, {
        repository: createDrizzleMemoryRepository(database),
        profileRepository: createDrizzleProfileRepository(database),
        gateway,
      }, onPrepared);
    },
    plan: () => planRoomFinalization(roomId, {
      repository: createDrizzleMemoryRepository(database),
      profileRepository: createDrizzleProfileRepository(database),
      gateway,
    }),
    apply: (plan) => database.transaction((transaction) => applyRoomFinalization(
      plan as Awaited<ReturnType<typeof planRoomFinalization>>,
      {
        repository: createDrizzleMemoryRepository(transaction),
        profileRepository: createTransactionBoundDrizzleProfileRepository(transaction),
        gateway,
      },
    )),
  };
}

/** Serializes one room while keeping provider calls outside database transactions. */
export async function analyzeImportedRoom(roomId: string): Promise<RoomMemoryResult> {
  return withDedicatedDatabase((database) => withRoomAnalysisLock(
    database,
    roomId,
    () => runRoomAnalysis(roomId, productionOperations(roomId, database)),
  ));
}

export async function getRoomAnalysisProgress(roomId: string): Promise<AnalysisProgress | null> {
  return createDrizzleAnalysisProgressRepository().get(roomId);
}
