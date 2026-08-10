import { createHash } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { getDb } from "@/db/client";
import {
  chunks,
  messages as messageRows,
  participants,
  roomMemories,
  turns as turnRows,
} from "@/db/schema";
import { decryptJson, encryptJson } from "@/domain/crypto/encrypted-json";
import type { ModelGateway } from "@/domain/models/gateway";
import { OpenAIModelGateway } from "@/domain/models/openai-gateway";
import {
  createDrizzleProfileRepository,
  ProfileService,
  profileFactKinds,
  type AiProfileFact,
  type ProfileFactView,
  type ProfileRepository,
} from "@/domain/profiles/profile-service";

export type RoomMemoryResult = {
  roomId: string;
  updatedChunkIds: string[];
  proposedFacts: ProfileFactView[];
};

export type MemoryMessage = {
  kind: string;
  text: string;
};

export type MemoryTurn = {
  id: string;
  participantId: string;
  participantName: string;
  messages: MemoryMessage[];
};

export type MemoryChunk = {
  id: string;
  roomId: string;
  startedAt: Date;
  endedAt: Date;
  turns: MemoryTurn[];
  previousAnalysisKey?: string;
  previousAnalysisKeys?: string[];
  legacyAnalysisIncomplete?: boolean;
  legacyIncompleteEvidenceTurnIds?: string[];
};

export type RoomParticipantIdentity = {
  id: string;
  name: string;
};

export type ChunkMemoryPayload = {
  summary: string;
  emotions: string[];
  relationshipSignals: string[];
  sourceFingerprint: string;
  analysisKey: string;
  analysisPrepared?: boolean;
  analysisComplete: boolean;
  candidateProfileFacts?: AiProfileFact[];
  previousAnalysisKeys?: string[];
  legacyAnalysisIncomplete?: boolean;
  legacyIncompleteEvidenceTurnIds?: string[];
};

export type ChunkMemoryUpdate = {
  roomId: string;
  chunkId: string;
  encryptedSummary: string;
  encryptedTopicTags: string;
  encryptedEventTypes: string;
  embedding: number[];
};

export type StoredChunkMemory = ChunkMemoryPayload & {
  chunkId: string;
  topicTags: string[];
  eventTypes: string[];
};

export type TopicMemory = {
  key: string;
  tags: string[];
  childChunkIds: string[];
  summary: string;
};

export type RoomMemoryPayload = {
  version: 1;
  topics: TopicMemory[];
  summary: string;
};

export interface MemoryRepository {
  /** Returns chunks whose source changed or whose downstream analysis is incomplete. */
  listChunksForAnalysis(roomId: string): Promise<MemoryChunk[]>;
  listRoomParticipants(roomId: string): Promise<RoomParticipantIdentity[]>;
  updateChunkMemory(update: ChunkMemoryUpdate): Promise<void>;
  listChunkMemories(roomId: string): Promise<StoredChunkMemory[]>;
  markChunksComplete(roomId: string, chunkIds: string[]): Promise<void>;
  upsertRoomMemory(roomId: string, encryptedSummary: string): Promise<void>;
}

type DrizzleExecutor = Pick<
  NodePgDatabase<typeof import("@/db/schema")>,
  "select" | "update" | "insert"
>;

export function createDrizzleMemoryRepository(
  database: NodePgDatabase<typeof import("@/db/schema")> = getDb(),
): MemoryRepository {
  const executor = database as DrizzleExecutor;
  async function roomParticipantIdentities(roomId: string): Promise<RoomParticipantIdentity[]> {
    const rows = await executor.select({
      id: participants.id,
      encryptedName: participants.encryptedName,
    }).from(participants).where(eq(participants.roomId, roomId));
    return rows.map((row) => ({ id: row.id, name: decryptJson<string>(row.encryptedName) }));
  }

  return {
    async listChunksForAnalysis(roomId) {
      const roomParticipants = await roomParticipantIdentities(roomId);
      const storedChunks = await executor.select({
        id: chunks.id,
        roomId: chunks.roomId,
        startTurnId: chunks.startTurnId,
        endTurnId: chunks.endTurnId,
        startedAt: chunks.startedAt,
        endedAt: chunks.endedAt,
        encryptedSummary: chunks.encryptedSummary,
      }).from(chunks).where(eq(chunks.roomId, roomId));
      const roomTurns = await executor.select({
        id: turnRows.id,
        participantId: turnRows.participantId,
        startedAt: turnRows.startedAt,
        encryptedMessageIds: turnRows.encryptedMessageIds,
      }).from(turnRows).where(eq(turnRows.roomId, roomId));
      roomTurns.sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime() || left.id.localeCompare(right.id));
      const turnIndexes = new Map(roomTurns.map((turn, index) => [turn.id, index]));

      const loaded = await Promise.all(storedChunks.map(async (storedChunk) => {
        const { encryptedSummary, ...chunk } = storedChunk;
        const start = turnIndexes.get(chunk.startTurnId);
        const end = turnIndexes.get(chunk.endTurnId);
        if (start === undefined || end === undefined || start > end) {
          throw new Error(`Chunk ${chunk.id} has invalid turn boundaries`);
        }
        const storedTurns = roomTurns.slice(start, end + 1);
        const messageIds = storedTurns.flatMap((turn) => decryptJson<string[]>(turn.encryptedMessageIds));
        const storedMessages = messageIds.length === 0
          ? []
          : await executor.select({
            id: messageRows.id,
            kind: messageRows.kind,
            encryptedText: messageRows.encryptedText,
            participantId: messageRows.participantId,
            encryptedName: participants.encryptedName,
          }).from(messageRows)
            .innerJoin(participants, eq(messageRows.participantId, participants.id))
            .where(inArray(messageRows.id, messageIds));
        const byMessageId = new Map(storedMessages.map((message) => [message.id, message]));

        const memoryChunk: MemoryChunk = {
          id: chunk.id,
          roomId: chunk.roomId,
          startedAt: chunk.startedAt,
          endedAt: chunk.endedAt,
          turns: storedTurns.map((turn) => {
            const turnMessageIds = decryptJson<string[]>(turn.encryptedMessageIds);
            const messages = turnMessageIds.map((id) => byMessageId.get(id)).filter((message) => message !== undefined);
            const first = messages[0];
            if (!first) throw new Error(`Turn ${turn.id} has no messages`);
            return {
              id: turn.id,
              participantId: turn.participantId,
              participantName: decryptJson<string>(first.encryptedName),
              messages: messages.map((message) => ({
                kind: message.kind,
                text: decryptJson<string>(message.encryptedText),
              })),
            };
          }),
        };
        return { memoryChunk, encryptedSummary };
      }));
      return loaded.flatMap<MemoryChunk>(({ memoryChunk, encryptedSummary }) => {
        const previous = decryptJson<Partial<ChunkMemoryPayload> | string>(encryptedSummary);
        const sourceFingerprint = chunkSourceFingerprint(memoryChunk, roomParticipants);
        const analysisKey = chunkAnalysisKey(roomId, memoryChunk.id, sourceFingerprint);
        const reusable = typeof previous !== "string"
          && previous.sourceFingerprint === sourceFingerprint
          && previous.analysisKey === analysisKey
          && (previous.analysisPrepared === true || previous.analysisComplete === true);
        const needsAnalysis = !reusable;
        if (!needsAnalysis) return [];
        if (typeof previous === "string") {
          return [memoryChunk];
        }
        const previousAnalysisKey = previous.analysisKey || undefined;
        const previousAnalysisKeys = [...new Set([
          ...(previousAnalysisKey ? [previousAnalysisKey] : []),
          ...(previous.previousAnalysisKeys ?? []).filter(Boolean),
        ])];
        const inheritedLegacyEvidence = previous.legacyAnalysisIncomplete === true
          ? previous.legacyIncompleteEvidenceTurnIds ?? []
          : [];
        const isLegacyIncomplete = previous.analysisComplete === false && !previousAnalysisKey;
        return [{
          ...memoryChunk,
          previousAnalysisKey,
          previousAnalysisKeys,
          legacyAnalysisIncomplete: isLegacyIncomplete || inheritedLegacyEvidence.length > 0,
          legacyIncompleteEvidenceTurnIds: isLegacyIncomplete
            ? memoryChunk.turns.map((turn) => turn.id)
            : inheritedLegacyEvidence,
        }];
      });
    },

    listRoomParticipants: roomParticipantIdentities,

    async updateChunkMemory(update) {
      await executor.update(chunks).set({
        encryptedSummary: update.encryptedSummary,
        encryptedTopicTags: update.encryptedTopicTags,
        encryptedEventTypes: update.encryptedEventTypes,
        embedding: update.embedding,
        updatedAt: new Date(),
      }).where(and(eq(chunks.id, update.chunkId), eq(chunks.roomId, update.roomId)));
    },

    async listChunkMemories(roomId) {
      const rows = await executor.select({
        id: chunks.id,
        encryptedSummary: chunks.encryptedSummary,
        encryptedTopicTags: chunks.encryptedTopicTags,
        encryptedEventTypes: chunks.encryptedEventTypes,
      }).from(chunks).where(eq(chunks.roomId, roomId));
      return rows.map((row) => {
        const decoded = decryptJson<ChunkMemoryPayload | string>(row.encryptedSummary);
        const payload = typeof decoded === "string"
          ? {
            summary: decoded,
            emotions: [],
            relationshipSignals: [],
            sourceFingerprint: "",
            analysisKey: "",
            analysisComplete: false,
          }
          : decoded;
        return {
          chunkId: row.id,
          summary: payload.summary ?? "",
          emotions: payload.emotions ?? [],
          relationshipSignals: payload.relationshipSignals ?? [],
          sourceFingerprint: payload.sourceFingerprint ?? "",
          analysisKey: payload.analysisKey ?? "",
          analysisPrepared: payload.analysisPrepared === true || payload.analysisComplete === true,
          analysisComplete: payload.analysisComplete === true,
          candidateProfileFacts: payload.candidateProfileFacts ?? [],
          previousAnalysisKeys: payload.previousAnalysisKeys ?? [],
          legacyAnalysisIncomplete: payload.legacyAnalysisIncomplete === true,
          legacyIncompleteEvidenceTurnIds: payload.legacyIncompleteEvidenceTurnIds ?? [],
          topicTags: decryptJson<string[]>(row.encryptedTopicTags),
          eventTypes: decryptJson<string[]>(row.encryptedEventTypes),
        };
      });
    },

    async markChunksComplete(roomId, chunkIds) {
      if (chunkIds.length === 0) return;
      const rows = await executor.select({
        id: chunks.id,
        encryptedSummary: chunks.encryptedSummary,
      }).from(chunks).where(and(eq(chunks.roomId, roomId), inArray(chunks.id, chunkIds)));
      for (const row of rows) {
        const decoded = decryptJson<ChunkMemoryPayload | string>(row.encryptedSummary);
        if (typeof decoded === "string") throw new Error(`Chunk ${row.id} is not prepared`);
        await executor.update(chunks).set({
          encryptedSummary: encryptJson<ChunkMemoryPayload>({
            ...decoded,
            analysisPrepared: true,
            analysisComplete: true,
          }),
          updatedAt: new Date(),
        }).where(and(eq(chunks.id, row.id), eq(chunks.roomId, roomId)));
      }
    },

    async upsertRoomMemory(roomId, encryptedSummary) {
      await executor.insert(roomMemories).values({ roomId, encryptedSummary })
        .onConflictDoUpdate({
          target: roomMemories.roomId,
          set: { encryptedSummary, updatedAt: new Date() },
        });
    },
  };
}

const candidateProfileFactSchema = z.object({
  participantId: z.string().min(1),
  targetFactId: z.string().min(1).nullable(),
  kind: z.enum(profileFactKinds),
  value: z.string().trim().min(1),
  conditions: z.array(z.string()),
  exceptions: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  evidenceTurnIds: z.array(z.string().min(1)).min(1),
});

const chunkAnalysisSchema = z.object({
  topicTags: z.array(z.string()),
  eventTypes: z.array(z.string()),
  emotions: z.array(z.string()),
  relationshipSignals: z.array(z.string()),
  summary: z.string().trim().min(1),
  candidateProfileFacts: z.array(candidateProfileFactSchema),
});

const topicMemorySchema = z.object({
  topics: z.array(z.object({
    key: z.string().trim().min(1),
    tags: z.array(z.string()),
    childChunkIds: z.array(z.string().min(1)).min(1),
    summary: z.string().trim().min(1),
  })).min(1),
});

const roomSummarySchema = z.object({ summary: z.string().trim().min(1) });

export type MemoryExtractorDependencies = {
  repository: MemoryRepository;
  profileRepository: ProfileRepository;
  gateway: ModelGateway;
};

export class EvidenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceValidationError";
  }
}

export class HierarchyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HierarchyValidationError";
  }
}

function replaceAllLiteral(text: string, search: string, replacement: string): string {
  return search ? text.split(search).join(replacement) : text;
}

function participantNameTokens(roomParticipants: RoomParticipantIdentity[]): Array<[string, string]> {
  const idsByName = new Map<string, string[]>();
  for (const participant of roomParticipants) {
    const ids = idsByName.get(participant.name) ?? [];
    ids.push(participant.id);
    idsByName.set(participant.name, ids);
  }
  return [...idsByName.entries()].map(([name, ids]): [string, string] => {
    const sortedIds = [...ids].sort();
    const token = sortedIds.length === 1
      ? `[participant:${sortedIds[0]}]`
      : `[participants:${sortedIds.join("|")}]`;
    return [name, token];
  }).sort(([left], [right]) => right.length - left.length || left.localeCompare(right));
}

/** Every room participant name is replaced before model or embedding use. */
export function redactChunkForEmbedding(
  chunk: MemoryChunk,
  roomParticipants: RoomParticipantIdentity[],
): string {
  const nameTokens = participantNameTokens(roomParticipants);
  return chunk.turns.map((turn) => {
    const content = turn.messages.map((message) => `${message.kind}:${message.text}`).join(" ");
    const redacted = nameTokens.reduce(
      (text, [name, token]) => replaceAllLiteral(text, name, token),
      content,
    );
    return `[turn:${turn.id}] [participant:${turn.participantId}] ${redacted}`;
  }).join("\n");
}

function chunkSourceFingerprint(
  chunk: MemoryChunk,
  roomParticipants: RoomParticipantIdentity[],
): string {
  return createHash("sha256").update(redactChunkForEmbedding(chunk, roomParticipants)).digest("hex");
}

function chunkAnalysisKey(roomId: string, chunkId: string, sourceFingerprint: string): string {
  return createHash("sha256")
    .update(JSON.stringify([roomId, chunkId, sourceFingerprint]))
    .digest("hex");
}

function validateEvidence(
  chunk: MemoryChunk,
  fact: Omit<AiProfileFact, "analysisKey">,
  roomParticipants: RoomParticipantIdentity[],
  existingFacts: ProfileFactView[],
): void {
  const participantsInRoom = new Set(roomParticipants.map((participant) => participant.id));
  const turnsInChunk = new Set(chunk.turns.map((turn) => turn.id));
  if (!participantsInRoom.has(fact.participantId)) {
    throw new EvidenceValidationError("AI profile fact references a participant outside the room");
  }
  if (fact.evidenceTurnIds.some((turnId) => !turnsInChunk.has(turnId))) {
    throw new EvidenceValidationError("AI profile fact references evidence outside the chunk");
  }
  if (fact.targetFactId) {
    const target = existingFacts.find((candidate) => candidate.id === fact.targetFactId);
    if (!target || target.participantId !== fact.participantId || target.kind !== fact.kind) {
      throw new EvidenceValidationError("AI profile target must match the same participant and fact kind");
    }
  }
}

function validateTopicMemories(topics: TopicMemory[], chunksToCover: StoredChunkMemory[]): void {
  const knownChunkIds = new Set(chunksToCover.map((chunk) => chunk.chunkId));
  const coveredChunkIds = new Set<string>();
  const topicKeys = new Set<string>();
  for (const topic of topics) {
    if (topicKeys.has(topic.key)) throw new HierarchyValidationError("Topic memory keys must be unique");
    topicKeys.add(topic.key);
    for (const chunkId of topic.childChunkIds) {
      if (!knownChunkIds.has(chunkId)) throw new HierarchyValidationError("Topic memory references an unknown chunk");
      coveredChunkIds.add(chunkId);
    }
  }
  if ([...knownChunkIds].some((chunkId) => !coveredChunkIds.has(chunkId))) {
    throw new HierarchyValidationError("Topic memories must cover every room chunk");
  }
}

function defaultDependencies(): MemoryExtractorDependencies {
  return {
    repository: createDrizzleMemoryRepository(),
    profileRepository: createDrizzleProfileRepository(),
    gateway: new OpenAIModelGateway(),
  };
}

export type PreparedRoomAnalysis = {
  roomId: string;
  analysisKeys: string[];
  legacyEvidenceTurnIds: string[];
  profileOperations: AiProfileFact[];
  topicMemory: TopicMemory[];
  roomSummary: string;
  chunkIds: string[];
};

export async function prepareRoomChunks(
  roomId: string,
  dependencies: MemoryExtractorDependencies = defaultDependencies(),
  onPrepared: (completedChunks: number) => Promise<void> = async () => {},
): Promise<string[]> {
  const [pendingChunks, existingMemories, roomParticipants] = await Promise.all([
    dependencies.repository.listChunksForAnalysis(roomId),
    dependencies.repository.listChunkMemories(roomId),
    dependencies.repository.listRoomParticipants(roomId),
  ]);
  if (pendingChunks.length === 0) return [];

  const profileService = new ProfileService(dependencies.profileRepository);
  const preparedChunks = pendingChunks.map((chunk) => {
    const redactedText = redactChunkForEmbedding(chunk, roomParticipants);
    const sourceFingerprint = chunkSourceFingerprint(chunk, roomParticipants);
    return {
      chunk,
      redactedText,
      sourceFingerprint,
      analysisKey: chunkAnalysisKey(roomId, chunk.id, sourceFingerprint),
      previousAnalysisKeys: [...new Set([
        ...(chunk.previousAnalysisKey ? [chunk.previousAnalysisKey] : []),
        ...(chunk.previousAnalysisKeys ?? []),
      ].filter(Boolean))],
      legacyIncompleteEvidenceTurnIds: chunk.legacyAnalysisIncomplete === true
        ? [...new Set(chunk.legacyIncompleteEvidenceTurnIds ?? [])]
        : [],
    };
  });
  const excludedKeys = [...new Set(preparedChunks.flatMap((item) => [
    item.analysisKey,
    ...item.previousAnalysisKeys,
  ]))];
  const existingProfileFacts = (await Promise.all(roomParticipants.map((participant) => (
    profileService.listProfileFacts(participant.id, excludedKeys)
  )))).flat();
  const pendingChunkIds = new Set(pendingChunks.map((chunk) => chunk.id));
  const completedBefore = existingMemories.filter((memory) => (
    !pendingChunkIds.has(memory.chunkId)
    && (memory.analysisPrepared === true || memory.analysisComplete === true)
  )).length;

  const updatedChunkIds: string[] = [];
  for (const [index, prepared] of preparedChunks.entries()) {
    const analysis = await dependencies.gateway.extract({
      purpose: "analysis",
      schemaName: "conversation_chunk_memory",
      schema: chunkAnalysisSchema,
      system: [
        "Extract only evidence-grounded conversation memory.",
        "Use supplied stable participant and turn IDs verbatim.",
        "Set targetFactId only to a supplied same-participant, same-kind fact that this result updates or contradicts; otherwise use null.",
        "Media and deleted events are weak evidence and must not support personality claims alone.",
        "Every candidate profile fact needs one or more evidence turn IDs and confidence from 0 through 1.",
      ].join(" "),
      input: JSON.stringify({
        roomId,
        chunkId: prepared.chunk.id,
        conversation: prepared.redactedText,
        existingProfileFacts: existingProfileFacts.map((fact) => ({
          id: fact.id,
          participantId: fact.participantId,
          kind: fact.kind,
          value: fact.value,
        })),
      }),
    });
    for (const fact of analysis.candidateProfileFacts) {
      validateEvidence(prepared.chunk, fact, roomParticipants, existingProfileFacts);
    }
    const [embedding] = await dependencies.gateway.embed([prepared.redactedText]);
    if (!embedding || embedding.length === 0) throw new Error("Model returned an empty embedding");
    const candidateProfileFacts = analysis.candidateProfileFacts.map((candidate) => ({
      ...candidate,
      analysisKey: prepared.analysisKey,
    }));
    await dependencies.repository.updateChunkMemory({
      roomId,
      chunkId: prepared.chunk.id,
      encryptedSummary: encryptJson<ChunkMemoryPayload>({
        summary: analysis.summary,
        emotions: analysis.emotions,
        relationshipSignals: analysis.relationshipSignals,
        sourceFingerprint: prepared.sourceFingerprint,
        analysisKey: prepared.analysisKey,
        analysisPrepared: true,
        analysisComplete: false,
        candidateProfileFacts,
        previousAnalysisKeys: prepared.previousAnalysisKeys,
        legacyAnalysisIncomplete: prepared.legacyIncompleteEvidenceTurnIds.length > 0,
        legacyIncompleteEvidenceTurnIds: prepared.legacyIncompleteEvidenceTurnIds,
      }),
      encryptedTopicTags: encryptJson(analysis.topicTags),
      encryptedEventTypes: encryptJson(analysis.eventTypes),
      embedding,
    });
    updatedChunkIds.push(prepared.chunk.id);
    await onPrepared(completedBefore + index + 1);
  }
  return updatedChunkIds;
}

export async function planRoomFinalization(
  roomId: string,
  dependencies: MemoryExtractorDependencies = defaultDependencies(),
): Promise<PreparedRoomAnalysis> {
  const storedChildMemories = await dependencies.repository.listChunkMemories(roomId);
  if (storedChildMemories.length === 0 || storedChildMemories.some((memory) => (
    memory.analysisPrepared !== true && memory.analysisComplete !== true
  ))) {
    throw new HierarchyValidationError("Every room chunk must be prepared before hierarchy synthesis");
  }
  const topicResult = await dependencies.gateway.extract({
    purpose: "analysis",
    schemaName: "topic_memories",
    schema: topicMemorySchema,
    system: [
      "Synthesize explicit topic memories from all room chunk memories.",
      "Every child chunk ID must appear in at least one topic, and topic keys must be stable and unique.",
      "Use only supplied child chunk IDs.",
    ].join(" "),
    input: JSON.stringify({
      roomId,
      childMemories: storedChildMemories.map(({
        sourceFingerprint: _sourceFingerprint,
        analysisKey: _analysisKey,
        analysisPrepared: _analysisPrepared,
        analysisComplete: _analysisComplete,
        candidateProfileFacts: _candidateProfileFacts,
        previousAnalysisKeys: _previousAnalysisKeys,
        legacyAnalysisIncomplete: _legacyAnalysisIncomplete,
        legacyIncompleteEvidenceTurnIds: _legacyIncompleteEvidenceTurnIds,
        ...memory
      }) => memory),
    }),
  });
  validateTopicMemories(topicResult.topics, storedChildMemories);
  const roomMemory = await dependencies.gateway.extract({
    purpose: "analysis",
    schemaName: "room_memory",
    schema: roomSummarySchema,
    system: [
      "Build a hierarchical room summary from topic memories only.",
      "Capture relationship structure, atmosphere, recurring events, nicknames, jokes, sensitive topics, and major changes when supported.",
    ].join(" "),
    input: JSON.stringify({ roomId, topicMemories: topicResult.topics }),
  });
  return {
    roomId,
    analysisKeys: [...new Set(storedChildMemories.flatMap((memory) => [
      memory.analysisKey,
      ...(memory.previousAnalysisKeys ?? []),
    ]).filter(Boolean))],
    legacyEvidenceTurnIds: [...new Set(storedChildMemories.flatMap((memory) => (
      memory.legacyAnalysisIncomplete === true ? memory.legacyIncompleteEvidenceTurnIds ?? [] : []
    )))],
    profileOperations: storedChildMemories.flatMap((memory) => memory.candidateProfileFacts ?? []),
    topicMemory: topicResult.topics,
    roomSummary: roomMemory.summary,
    chunkIds: storedChildMemories.map((memory) => memory.chunkId),
  };
}

export async function applyRoomFinalization(
  plan: PreparedRoomAnalysis,
  dependencies: MemoryExtractorDependencies = defaultDependencies(),
): Promise<RoomMemoryResult> {
  const proposedFacts = await new ProfileService(dependencies.profileRepository).replaceAiAnalysis(
    plan.analysisKeys,
    plan.profileOperations,
    plan.legacyEvidenceTurnIds,
  );
  await dependencies.repository.upsertRoomMemory(plan.roomId, encryptJson<RoomMemoryPayload>({
    version: 1,
    topics: plan.topicMemory,
    summary: plan.roomSummary,
  }));
  await dependencies.repository.markChunksComplete(plan.roomId, plan.chunkIds);
  return { roomId: plan.roomId, updatedChunkIds: plan.chunkIds, proposedFacts };
}

export async function extractRoomMemory(
  roomId: string,
  dependencies: MemoryExtractorDependencies = defaultDependencies(),
  onPrepared: (completedChunks: number) => Promise<void> = async () => {},
): Promise<RoomMemoryResult> {
  const [before, pending] = await Promise.all([
    dependencies.repository.listChunkMemories(roomId),
    dependencies.repository.listChunksForAnalysis(roomId),
  ]);
  if (pending.length === 0 && before.length > 0 && before.every((memory) => memory.analysisComplete === true)) {
    return { roomId, updatedChunkIds: [], proposedFacts: [] };
  }
  await prepareRoomChunks(roomId, dependencies, onPrepared);
  const plan = await planRoomFinalization(roomId, dependencies);
  return applyRoomFinalization(plan, dependencies);
}
