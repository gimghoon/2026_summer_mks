import { createHash } from "node:crypto";

import { and, eq, gte, inArray, lte } from "drizzle-orm";
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
  analysisComplete: boolean;
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
        startedAt: chunks.startedAt,
        endedAt: chunks.endedAt,
        encryptedSummary: chunks.encryptedSummary,
      }).from(chunks).where(eq(chunks.roomId, roomId));

      const loaded = await Promise.all(storedChunks.map(async (storedChunk) => {
        const { encryptedSummary, ...chunk } = storedChunk;
        const storedTurns = await executor.select({
          id: turnRows.id,
          participantId: turnRows.participantId,
          startedAt: turnRows.startedAt,
          encryptedMessageIds: turnRows.encryptedMessageIds,
        }).from(turnRows).where(and(
          eq(turnRows.roomId, roomId),
          gte(turnRows.startedAt, chunk.startedAt),
          lte(turnRows.endedAt, chunk.endedAt),
        ));
        storedTurns.sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
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
          ...chunk,
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
      return loaded.filter(({ memoryChunk, encryptedSummary }) => {
        const previous = decryptJson<Partial<ChunkMemoryPayload> | string>(encryptedSummary);
        return typeof previous === "string"
          || previous.analysisComplete !== true
          || previous.sourceFingerprint !== chunkSourceFingerprint(memoryChunk, roomParticipants);
      }).map(({ memoryChunk }) => memoryChunk);
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
          analysisComplete: payload.analysisComplete === true,
          topicTags: decryptJson<string[]>(row.encryptedTopicTags),
          eventTypes: decryptJson<string[]>(row.encryptedEventTypes),
        };
      });
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
    throw new Error("AI profile fact references a participant outside the room");
  }
  if (fact.evidenceTurnIds.some((turnId) => !turnsInChunk.has(turnId))) {
    throw new Error("AI profile fact references evidence outside the chunk");
  }
  if (fact.targetFactId) {
    const target = existingFacts.find((candidate) => candidate.id === fact.targetFactId);
    if (!target || target.participantId !== fact.participantId || target.kind !== fact.kind) {
      throw new Error("AI profile target must match the same participant and fact kind");
    }
  }
}

function validateTopicMemories(topics: TopicMemory[], chunksToCover: StoredChunkMemory[]): void {
  const knownChunkIds = new Set(chunksToCover.map((chunk) => chunk.chunkId));
  const coveredChunkIds = new Set<string>();
  const topicKeys = new Set<string>();
  for (const topic of topics) {
    if (topicKeys.has(topic.key)) throw new Error("Topic memory keys must be unique");
    topicKeys.add(topic.key);
    for (const chunkId of topic.childChunkIds) {
      if (!knownChunkIds.has(chunkId)) throw new Error("Topic memory references an unknown chunk");
      coveredChunkIds.add(chunkId);
    }
  }
  if ([...knownChunkIds].some((chunkId) => !coveredChunkIds.has(chunkId))) {
    throw new Error("Topic memories must cover every room chunk");
  }
}

function defaultDependencies(): MemoryExtractorDependencies {
  return {
    repository: createDrizzleMemoryRepository(),
    profileRepository: createDrizzleProfileRepository(),
    gateway: new OpenAIModelGateway(),
  };
}

export async function extractRoomMemory(
  roomId: string,
  dependencies: MemoryExtractorDependencies = defaultDependencies(),
): Promise<RoomMemoryResult> {
  const pendingChunks = await dependencies.repository.listChunksForAnalysis(roomId);
  if (pendingChunks.length === 0) {
    return { roomId, updatedChunkIds: [], proposedFacts: [] };
  }

  const roomParticipants = await dependencies.repository.listRoomParticipants(roomId);
  const profileService = new ProfileService(dependencies.profileRepository);
  const preparedChunks = pendingChunks.map((chunk) => {
    const redactedText = redactChunkForEmbedding(chunk, roomParticipants);
    const sourceFingerprint = chunkSourceFingerprint(chunk, roomParticipants);
    return {
      chunk,
      redactedText,
      sourceFingerprint,
      analysisKey: chunkAnalysisKey(roomId, chunk.id, sourceFingerprint),
    };
  });
  const pendingAnalysisKeys = preparedChunks.map((item) => item.analysisKey);
  const existingProfileFacts = (await Promise.all(roomParticipants.map((participant) => (
    profileService.listProfileFacts(participant.id, pendingAnalysisKeys)
  )))).flat();

  const analyses = [];
  for (const prepared of preparedChunks) {
    const { chunk, redactedText, sourceFingerprint, analysisKey } = prepared;
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
        chunkId: chunk.id,
        conversation: redactedText,
        existingProfileFacts: existingProfileFacts.map((fact) => ({
          id: fact.id,
          participantId: fact.participantId,
          kind: fact.kind,
          value: fact.value,
        })),
      }),
    });
    for (const fact of analysis.candidateProfileFacts) {
      validateEvidence(chunk, fact, roomParticipants, existingProfileFacts);
    }
    analyses.push({ chunk, redactedText, sourceFingerprint, analysisKey, analysis });
  }

  const embeddings = await dependencies.gateway.embed(analyses.map((item) => item.redactedText));
  if (embeddings.length !== analyses.length) throw new Error("Embedding count did not match chunk count");

  const updates = analyses.map((item, index) => {
    const embedding = embeddings[index];
    if (!embedding || embedding.length === 0) throw new Error("Model returned an empty embedding");
    return {
      item,
      embedding,
      encryptedTopicTags: encryptJson(item.analysis.topicTags),
      encryptedEventTypes: encryptJson(item.analysis.eventTypes),
    };
  });

  // A fingerprint alone is not a completion marker. Persist the analyzed
  // content as incomplete before any downstream profile or hierarchy writes.
  for (const update of updates) {
    await dependencies.repository.updateChunkMemory({
      roomId,
      chunkId: update.item.chunk.id,
      encryptedSummary: encryptJson<ChunkMemoryPayload>({
        summary: update.item.analysis.summary,
        emotions: update.item.analysis.emotions,
        relationshipSignals: update.item.analysis.relationshipSignals,
        sourceFingerprint: update.item.sourceFingerprint,
        analysisKey: update.item.analysisKey,
        analysisComplete: false,
      }),
      encryptedTopicTags: update.encryptedTopicTags,
      encryptedEventTypes: update.encryptedEventTypes,
      embedding: update.embedding,
    });
  }

  const storedChildMemories = await dependencies.repository.listChunkMemories(roomId);
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
        analysisComplete: _analysisComplete,
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
    input: JSON.stringify({
      roomId,
      topicMemories: topicResult.topics,
    }),
  });

  // No profile writes occur until every model and embedding call succeeds.
  // Replacement cleanup and replay share one profile transaction.
  const profileOperations = analyses.flatMap((item) => (
    item.analysis.candidateProfileFacts.map((candidate) => ({
      ...candidate,
      analysisKey: item.analysisKey,
    }))
  ));
  const proposedFacts: ProfileFactView[] = await profileService.replaceAiAnalysis(
    analyses.map((item) => item.analysisKey),
    profileOperations,
  );

  await dependencies.repository.upsertRoomMemory(roomId, encryptJson<RoomMemoryPayload>({
    version: 1,
    topics: topicResult.topics,
    summary: roomMemory.summary,
  }));

  // Completion is the final write. Any earlier failure leaves these chunks
  // retryable even when their source fingerprint is unchanged.
  for (const update of updates) {
    await dependencies.repository.updateChunkMemory({
      roomId,
      chunkId: update.item.chunk.id,
      encryptedSummary: encryptJson<ChunkMemoryPayload>({
        summary: update.item.analysis.summary,
        emotions: update.item.analysis.emotions,
        relationshipSignals: update.item.analysis.relationshipSignals,
        sourceFingerprint: update.item.sourceFingerprint,
        analysisKey: update.item.analysisKey,
        analysisComplete: true,
      }),
      encryptedTopicTags: update.encryptedTopicTags,
      encryptedEventTypes: update.encryptedEventTypes,
      embedding: update.embedding,
    });
  }

  return {
    roomId,
    updatedChunkIds: analyses.map((item) => item.chunk.id),
    proposedFacts,
  };
}
