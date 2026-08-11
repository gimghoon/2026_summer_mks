import { and, asc, eq, inArray } from "drizzle-orm";

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
import {
  validatesReplyFact,
} from "@/domain/replies/reply-production-policy";
import { OpenAIModelGateway } from "@/domain/models/openai-gateway";
import { listProfileFacts } from "@/domain/profiles/profile-service";
import {
  generateReplies,
  type GenerateRepliesCommand,
  type ParticipantProfileContext,
} from "@/domain/replies/reply-service";
import { createPersonalContextUsageValidator } from "@/domain/replies/personal-context-usage-validator";
import {
  buildProductionReplyContext,
  type ProductionContextSnapshot,
} from "@/domain/replies/production-context";
import { safeLog } from "@/lib/logger";
import { getRoomView } from "@/domain/rooms/room-read-service";
import {
  fixtureModeEnabled,
  fixtureParticipantBelongsToRoom,
  generateFixtureReplies,
  getFixtureRoom,
} from "@/domain/testing/e2e-fixture-store";

type StoredRoomMemory = { version?: number; summary?: string } | string;
type StoredChunkMemory = {
  summary?: string;
  emotions?: string[];
  relationshipSignals?: string[];
} | string;

async function loadParticipantProfileContext(
  participantId: string,
): Promise<ParticipantProfileContext[]> {
  return (await listProfileFacts(participantId)).map((fact) => ({
    id: fact.id,
    kind: fact.kind,
    value: fact.value,
    conditions: fact.conditions,
    exceptions: fact.exceptions,
    source: fact.source,
    locked: fact.locked,
  }));
}

async function productionContextSnapshot(
  command: GenerateRepliesCommand,
  preloadedProfiles?: ParticipantProfileContext[],
): Promise<ProductionContextSnapshot> {
  const database = getDb();
  const [storedTurns, storedChunks, memoryRows, roomParticipantRows, participantProfiles] = await Promise.all([
    database.select({
      id: turns.id,
      participantId: turns.participantId,
      startedAt: turns.startedAt,
      encryptedMessageIds: turns.encryptedMessageIds,
    }).from(turns).where(eq(turns.roomId, command.roomId)).orderBy(asc(turns.startedAt), asc(turns.id)),
    database.select({
      id: chunks.id,
      roomId: chunks.roomId,
      startTurnId: chunks.startTurnId,
      endTurnId: chunks.endTurnId,
      startedAt: chunks.startedAt,
      endedAt: chunks.endedAt,
      embedding: chunks.embedding,
      encryptedSummary: chunks.encryptedSummary,
      encryptedTopicTags: chunks.encryptedTopicTags,
      encryptedEventTypes: chunks.encryptedEventTypes,
    }).from(chunks).where(eq(chunks.roomId, command.roomId)),
    database.select({ encryptedSummary: roomMemories.encryptedSummary })
      .from(roomMemories).where(eq(roomMemories.roomId, command.roomId)),
    database.select({
      id: participants.id,
      encryptedName: participants.encryptedName,
      isSelf: participants.isSelf,
    }).from(participants).where(eq(participants.roomId, command.roomId)),
    preloadedProfiles ?? loadParticipantProfileContext(command.participantId),
  ]);
  const messageIds = storedTurns.flatMap((turn) => decryptJson<string[]>(turn.encryptedMessageIds));
  const storedMessages = messageIds.length === 0 ? [] : await database.select({
    id: messages.id,
    kind: messages.kind,
    encryptedText: messages.encryptedText,
  }).from(messages).where(and(eq(messages.roomId, command.roomId), inArray(messages.id, messageIds)));
  const byId = new Map(storedMessages.map((message) => [message.id, message]));
  const decryptedTurns = storedTurns.map((turn) => ({
    id: turn.id,
    speakerId: turn.participantId,
    startedAt: turn.startedAt,
    messages: decryptJson<string[]>(turn.encryptedMessageIds).flatMap((id) => {
      const message = byId.get(id);
      return message ? [{ kind: message.kind as "text" | "media_event" | "deleted_event", text: decryptJson<string>(message.encryptedText) }] : [];
    }),
  })).filter((turn) => turn.messages.length > 0);
  const turnIndexes = new Map(decryptedTurns.map((turn, index) => [turn.id, index]));
  const roomMemory = memoryRows[0]
    ? (() => {
      const decoded = decryptJson<StoredRoomMemory>(memoryRows[0]!.encryptedSummary);
      return typeof decoded === "string" ? decoded : decoded.summary ?? null;
    })()
    : null;
  return {
    roomParticipants: roomParticipantRows.map((participant) => ({
      id: participant.id,
      name: decryptJson<string>(participant.encryptedName),
      isSelf: participant.isSelf,
    })),
    chunks: storedChunks.map((chunk) => {
      const start = turnIndexes.get(chunk.startTurnId);
      const end = turnIndexes.get(chunk.endTurnId);
      if (start === undefined || end === undefined || start > end) {
        throw new Error(`Chunk ${chunk.id} has invalid turn boundaries`);
      }
      const decoded = decryptJson<StoredChunkMemory>(chunk.encryptedSummary);
      return {
        chunkId: chunk.id,
        roomId: chunk.roomId,
        startedAt: chunk.startedAt,
        endedAt: chunk.endedAt,
        embedding: chunk.embedding,
        summary: typeof decoded === "string" ? decoded : decoded.summary ?? "",
        emotions: typeof decoded === "string" ? [] : decoded.emotions ?? [],
        relationshipSignals: typeof decoded === "string" ? [] : decoded.relationshipSignals ?? [],
        topicTags: decryptJson<string[]>(chunk.encryptedTopicTags),
        eventTypes: decryptJson<string[]>(chunk.encryptedEventTypes),
        turns: decryptedTurns.slice(start, end + 1),
      };
    }),
    roomMemory,
    participantProfiles,
  };
}

async function replyContext(
  command: GenerateRepliesCommand,
  relationship: RelationshipStyle,
  gateway: OpenAIModelGateway,
  snapshot: ProductionContextSnapshot,
  preloadedProfiles?: ProductionContextSnapshot["participantProfiles"],
) {
  return buildProductionReplyContext(
    command,
    relationship,
    gateway,
    {
      ...snapshot,
      participantProfiles: preloadedProfiles ?? snapshot.participantProfiles,
    },
  );
}

function productionDependencies(): ReplyRouteDependencies {
  return {
    requireSession,
    async isRoomReady(roomId) { return (await getRoomView(roomId))?.analysisStatus === "ready"; },
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
      let snapshotPromise: Promise<ProductionContextSnapshot> | undefined;
      let preloadedProfiles: ParticipantProfileContext[] | undefined;
      const loadSnapshot = (profiles?: ParticipantProfileContext[]) => {
        snapshotPromise ??= productionContextSnapshot(command, profiles);
        return snapshotPromise;
      };
      return generateReplies(command, {
        gateway,
        personalContextUsageValidator: createPersonalContextUsageValidator(gateway),
        contextProvider: {
          async loadParticipantProfiles(currentCommand) {
            preloadedProfiles ??= await loadParticipantProfileContext(currentCommand.participantId);
            return preloadedProfiles;
          },
          async load(currentCommand, providedProfiles) {
            const profiles = providedProfiles ?? preloadedProfiles;
            return replyContext(
              currentCommand,
              relationship,
              gateway,
              await loadSnapshot(profiles),
              profiles,
            );
          },
        },
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
          personalContextMode: command.personalContextMode,
        }).returning({ id: replyRequests.id });
        const storedRequest = requestRows[0];
        if (!storedRequest) throw new Error("Could not record reply request");
        await transaction.insert(replyCandidates).values(candidates.map((candidate) => ({
          replyRequestId: storedRequest.id,
          strategy: candidate.strategy,
          encryptedText: encryptJson(candidate.text),
          encryptedIntentLabel: encryptJson(candidate.intentLabel),
          encryptedRiskLabel: candidate.riskLabel === null ? null : encryptJson(candidate.riskLabel),
          encryptedContextBasis: encryptJson(candidate.contextBasis),
          encryptedWarnings: encryptJson(candidate.warnings),
        })));
      });
    },
    log: safeLog,
  };
}

function fixtureDependencies(): ReplyRouteDependencies {
  return {
    requireSession,
    async isRoomReady(roomId) {
      return getFixtureRoom(roomId)?.analysisStatus === "ready";
    },
    async loadParticipant({ roomId, participantId }) {
      return fixtureParticipantBelongsToRoom(roomId, participantId)
        ? { relationship: "female_friend" }
        : null;
    },
    async generate(command) {
      return generateFixtureReplies(command);
    },
    async persist() {
      // The fixture generator stores encrypted request and candidate payloads
      // in its in-memory adapter before returning the browser response. Typed
      // unavailable results return before storage and never reach this hook.
    },
    log: safeLog,
  };
}

export const POST = createReplyPostHandler(
  fixtureModeEnabled() ? fixtureDependencies() : productionDependencies(),
);
