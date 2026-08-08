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

export type ChunkMemoryPayload = {
  summary: string;
  emotions: string[];
  relationshipSignals: string[];
  sourceFingerprint: string;
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

export interface MemoryRepository {
  /** Returns only chunks that the adapter considers new or changed. */
  listChunksForAnalysis(roomId: string): Promise<MemoryChunk[]>;
  updateChunkMemory(update: ChunkMemoryUpdate): Promise<void>;
  listChunkMemories?(roomId: string): Promise<StoredChunkMemory[]>;
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
  return {
    async listChunksForAnalysis(roomId) {
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
          || previous.sourceFingerprint !== chunkSourceFingerprint(memoryChunk);
      }).map(({ memoryChunk }) => memoryChunk);
    },

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
          ? { summary: decoded, emotions: [], relationshipSignals: [], sourceFingerprint: "" }
          : decoded;
        return {
          chunkId: row.id,
          ...payload,
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

const roomSummarySchema = z.object({ summary: z.string().trim().min(1) });

export type MemoryExtractorDependencies = {
  repository: MemoryRepository;
  profileRepository: ProfileRepository;
  gateway: ModelGateway;
};

function replaceAllLiteral(text: string, search: string, replacement: string): string {
  return search ? text.split(search).join(replacement) : text;
}

/** Stable participant IDs replace names in every string sent for embedding. */
export function redactChunkForEmbedding(chunk: MemoryChunk): string {
  const nameTokens = [...new Map(chunk.turns.map((turn) => [turn.participantName, turn.participantId])).entries()]
    .sort(([left], [right]) => right.length - left.length);
  return chunk.turns.map((turn) => {
    const content = turn.messages.map((message) => `${message.kind}:${message.text}`).join(" ");
    const redacted = nameTokens.reduce(
      (text, [name, participantId]) => replaceAllLiteral(text, name, `[participant:${participantId}]`),
      content,
    );
    return `[turn:${turn.id}] [participant:${turn.participantId}] ${redacted}`;
  }).join("\n");
}

function chunkSourceFingerprint(chunk: MemoryChunk): string {
  return createHash("sha256").update(redactChunkForEmbedding(chunk)).digest("hex");
}

function validateEvidence(chunk: MemoryChunk, fact: AiProfileFact): void {
  const participantsInChunk = new Set(chunk.turns.map((turn) => turn.participantId));
  const turnsInChunk = new Set(chunk.turns.map((turn) => turn.id));
  if (!participantsInChunk.has(fact.participantId)) {
    throw new Error("AI profile fact references a participant outside the chunk");
  }
  if (fact.evidenceTurnIds.some((turnId) => !turnsInChunk.has(turnId))) {
    throw new Error("AI profile fact references evidence outside the chunk");
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

  const analyses = [];
  for (const chunk of pendingChunks) {
    const redactedText = redactChunkForEmbedding(chunk);
    const analysis = await dependencies.gateway.extract({
      purpose: "analysis",
      schemaName: "conversation_chunk_memory",
      schema: chunkAnalysisSchema,
      system: [
        "Extract only evidence-grounded conversation memory.",
        "Use supplied stable participant and turn IDs verbatim.",
        "Media and deleted events are weak evidence and must not support personality claims alone.",
        "Every candidate profile fact needs one or more evidence turn IDs and confidence from 0 through 1.",
      ].join(" "),
      input: JSON.stringify({
        roomId,
        chunkId: chunk.id,
        conversation: redactedText,
      }),
    });
    for (const fact of analysis.candidateProfileFacts) validateEvidence(chunk, fact);
    analyses.push({ chunk, redactedText, analysis });
  }

  const embeddings = await dependencies.gateway.embed(analyses.map((item) => item.redactedText));
  if (embeddings.length !== analyses.length) throw new Error("Embedding count did not match chunk count");

  const profileService = new ProfileService(dependencies.profileRepository);
  const proposedFacts: ProfileFactView[] = [];
  for (let index = 0; index < analyses.length; index += 1) {
    const item = analyses[index]!;
    const embedding = embeddings[index];
    if (!embedding || embedding.length === 0) throw new Error("Model returned an empty embedding");
    await dependencies.repository.updateChunkMemory({
      roomId,
      chunkId: item.chunk.id,
      encryptedSummary: encryptJson<ChunkMemoryPayload>({
        summary: item.analysis.summary,
        emotions: item.analysis.emotions,
        relationshipSignals: item.analysis.relationshipSignals,
        sourceFingerprint: chunkSourceFingerprint(item.chunk),
      }),
      encryptedTopicTags: encryptJson(item.analysis.topicTags),
      encryptedEventTypes: encryptJson(item.analysis.eventTypes),
      embedding,
    });
    for (const candidate of item.analysis.candidateProfileFacts) {
      proposedFacts.push(await profileService.applyAiInference(candidate));
    }
  }

  const storedChildMemories = dependencies.repository.listChunkMemories
    ? await dependencies.repository.listChunkMemories(roomId)
    : analyses.map(({ chunk, analysis }) => ({
      chunkId: chunk.id,
      summary: analysis.summary,
      topicTags: analysis.topicTags,
      eventTypes: analysis.eventTypes,
      emotions: analysis.emotions,
      relationshipSignals: analysis.relationshipSignals,
      sourceFingerprint: chunkSourceFingerprint(chunk),
    }));
  const roomMemory = await dependencies.gateway.extract({
    purpose: "analysis",
    schemaName: "room_memory",
    schema: roomSummarySchema,
    system: [
      "Build a hierarchical room summary from child chunk memories only.",
      "Capture relationship structure, atmosphere, recurring events, nicknames, jokes, sensitive topics, and major changes when supported.",
    ].join(" "),
    input: JSON.stringify({
      roomId,
      childMemories: storedChildMemories.map(({ sourceFingerprint: _sourceFingerprint, ...memory }) => memory),
    }),
  });
  await dependencies.repository.upsertRoomMemory(roomId, encryptJson(roomMemory.summary));

  return {
    roomId,
    updatedChunkIds: analyses.map((item) => item.chunk.id),
    proposedFacts,
  };
}
