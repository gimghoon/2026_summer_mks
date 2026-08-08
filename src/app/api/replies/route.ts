import { and, desc, eq, inArray } from "drizzle-orm";

import { getDb } from "@/db/client";
import {
  chunks,
  messages,
  participants,
  replyCandidates,
  replyRequests,
  roomMemories,
  rooms,
  turns,
  type RelationshipStyle,
} from "@/db/schema";
import { requireSession } from "@/domain/auth/session";
import { decryptJson, encryptJson } from "@/domain/crypto/encrypted-json";
import {
  createReplyPostHandler,
  type ReplyBody,
  type ReplyRouteDependencies,
} from "@/domain/replies/reply-api-handler";
import { selectCurrentContext } from "@/domain/replies/context-expander";
import {
  createSubmittedContextJudge,
  submittedCurrentTurn,
  validatesReplyFact,
} from "@/domain/replies/reply-production-policy";
import { OpenAIModelGateway } from "@/domain/models/openai-gateway";
import { listProfileFacts } from "@/domain/profiles/profile-service";
import {
  generateReplies,
  type GenerateRepliesCommand,
} from "@/domain/replies/reply-service";
import { VectorContextRepository } from "@/domain/retrieval/vector-context-repository";
import { safeLog } from "@/lib/logger";

type StoredRoomMemory = { version?: number; summary?: string } | string;
type StoredChunkMemory = { summary?: string } | string;

async function currentRoomTurns(roomId: string) {
  const database = getDb();
  const storedTurns = await database.select({
    id: turns.id,
    participantId: turns.participantId,
    startedAt: turns.startedAt,
    encryptedMessageIds: turns.encryptedMessageIds,
  }).from(turns).where(eq(turns.roomId, roomId)).orderBy(desc(turns.startedAt)).limit(80);

  const chronologicalTurns = [...storedTurns].reverse();
  const messageIds = chronologicalTurns.flatMap((turn) => decryptJson<string[]>(turn.encryptedMessageIds));
  if (messageIds.length === 0) return [];
  const storedMessages = await database.select({
    id: messages.id,
    kind: messages.kind,
    encryptedText: messages.encryptedText,
  }).from(messages).where(and(eq(messages.roomId, roomId), inArray(messages.id, messageIds)));
  const byId = new Map(storedMessages.map((message) => [message.id, message]));

  return chronologicalTurns.map((turn) => ({
    id: turn.id,
    speakerId: turn.participantId,
    startedAt: turn.startedAt,
    messages: decryptJson<string[]>(turn.encryptedMessageIds).flatMap((id) => {
      const message = byId.get(id);
      return message ? [{ kind: message.kind as "text" | "media_event" | "deleted_event", text: decryptJson<string>(message.encryptedText) }] : [];
    }),
  })).filter((turn) => turn.messages.length > 0);
}

async function replyContext(
  command: GenerateRepliesCommand,
  relationship: RelationshipStyle,
  gateway: OpenAIModelGateway,
) {
  const database = getDb();
  const [allTurns, memoryRows, profileFacts] = await Promise.all([
    currentRoomTurns(command.roomId),
    database.select({ encryptedSummary: roomMemories.encryptedSummary })
      .from(roomMemories).where(eq(roomMemories.roomId, command.roomId)),
    listProfileFacts(command.participantId),
  ]);
  const submittedTurn = submittedCurrentTurn(command);
  const currentContext = await selectCurrentContext({
    // The current pasted exchange is always the newest context. Saved turns
    // provide expansion support, but cannot make a sparse new request appear
    // sufficient on their own.
    turns: [...allTurns, submittedTurn],
    fullChunkStart: 0,
    judge: createSubmittedContextJudge(command),
  });
  const roomMemory = memoryRows[0]
    ? (() => {
      const decoded = decryptJson<StoredRoomMemory>(memoryRows[0]!.encryptedSummary);
      return typeof decoded === "string" ? decoded : decoded.summary ?? null;
    })()
    : null;

  const [embedding] = await gateway.embed([
    `${command.pastedConversation}\n${command.situation}\n${command.intent}`,
  ]);
  const storedChunks = await database.select({
    id: chunks.id,
    roomId: chunks.roomId,
    startedAt: chunks.startedAt,
    embedding: chunks.embedding,
    encryptedSummary: chunks.encryptedSummary,
  }).from(chunks).where(eq(chunks.roomId, command.roomId));
  const contextRepository = new VectorContextRepository({
    listRankableChunks: async () => storedChunks.map((chunk) => ({
      chunkId: chunk.id,
      roomId: chunk.roomId,
      startedAt: chunk.startedAt,
      embedding: chunk.embedding,
      participantIds: [],
      topicTags: [],
      eventTypes: [],
      nicknames: [],
      sensitiveTopics: [],
      decrypt: async () => {
        const decoded = decryptJson<StoredChunkMemory>(chunk.encryptedSummary);
        return { summary: typeof decoded === "string" ? decoded : decoded.summary ?? "", turns: [] };
      },
    })),
  });
  const retrievedChunks = await contextRepository.findRelevant({
    roomId: command.roomId,
    participantIds: [command.participantId],
    queryEmbedding: embedding ?? [],
    topics: [],
    eventTypes: [],
    nicknames: [],
    limit: 5,
  });

  return {
    relationship,
    currentContext,
    retrievedChunks,
    roomMemory,
    participantProfiles: profileFacts.map((fact) => ({
      kind: fact.kind,
      value: fact.value,
      conditions: fact.conditions,
      exceptions: fact.exceptions,
    })),
    currentFacts: profileFacts.map((fact) => fact.value),
  };
}

function productionDependencies(): ReplyRouteDependencies {
  return {
    requireSession,
    async loadParticipant({ roomId, participantId }: Pick<ReplyBody, "roomId" | "participantId">) {
      const rows = await getDb().select({ relationshipStyle: participants.relationshipStyle })
        .from(participants)
        .innerJoin(rooms, eq(participants.roomId, rooms.id))
        .where(and(eq(participants.id, participantId), eq(participants.roomId, roomId)));
      const participant = rows[0];
      if (!participant) return null;
      return { relationship: participant.relationshipStyle ?? "female_friend" };
    },
    async generate(command, relationship) {
      const gateway = new OpenAIModelGateway();
      return generateReplies(command, {
        gateway,
        contextProvider: { load: (currentCommand) => replyContext(currentCommand, relationship, gateway) },
        factValidator: validatesReplyFact,
      });
    },
    async persist({ command, relationship, candidates }) {
      const database = getDb();
      await database.transaction(async (transaction) => {
        const scopedParticipant = await transaction.select({ id: participants.id }).from(participants)
          .where(and(eq(participants.id, command.participantId), eq(participants.roomId, command.roomId)));
        if (!scopedParticipant[0]) throw new Error("Room participant no longer exists");
        const requestRows = await transaction.insert(replyRequests).values({
          roomId: command.roomId,
          participantId: command.participantId,
          relationshipStyle: relationship,
          indirectness: command.indirectness,
          encryptedPastedConversation: encryptJson(command.pastedConversation),
          encryptedSituation: encryptJson(command.situation),
          encryptedIntent: encryptJson(command.intent),
        }).returning({ id: replyRequests.id });
        const storedRequest = requestRows[0];
        if (!storedRequest) throw new Error("Could not record reply request");
        await transaction.insert(replyCandidates).values(candidates.map((candidate) => ({
          replyRequestId: storedRequest.id,
          strategy: candidate.strategy,
          encryptedText: encryptJson(candidate.text),
          encryptedIntentLabel: encryptJson(candidate.intentLabel),
          encryptedRiskLabel: candidate.riskLabel === null ? null : encryptJson(candidate.riskLabel),
        })));
      });
    },
    log: safeLog,
  };
}

export const POST = createReplyPostHandler(productionDependencies());
