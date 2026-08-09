import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { getDb } from "@/db/client";
import { chunks, messages, participants, rooms, turns } from "@/db/schema";
import { decryptJson, encryptJson } from "@/domain/crypto/encrypted-json";
import {
  parseKakaoExport,
  type MessageKind,
  type ParsedMessageWithFingerprint,
} from "@/domain/kakao/parser";
import { groupMessageTurns } from "@/domain/kakao/turns";

export type ImportSummary = {
  roomId: string;
  insertedMessages: number;
  duplicateMessages: number;
  unparsedLines: Array<{ line: number; text: string }>;
};

export type ImportCommand = {
  title: string;
  selfName: string;
  rawText: string;
  existingRoomId?: string;
};

export type StoredMessage = ParsedMessageWithFingerprint & {
  id: string;
  participantId: string;
};

export type TurnToPersist = {
  participantId: string;
  startedAt: Date;
  endedAt: Date;
  encryptedMessageIds: string;
};

export interface ImportRepository {
  transaction<T>(work: (repository: ImportRepository) => Promise<T>): Promise<T>;
  resolveRoom(input: { encryptedTitle: string; existingRoomId?: string }): Promise<string>;
  resolveParticipants(
    roomId: string,
    entries: Array<{ name: string; encryptedName: string; isSelf: boolean }>,
  ): Promise<Map<string, string>>;
  insertMessage(input: {
    roomId: string;
    participantId: string;
    sentAt: Date;
    kind: MessageKind;
    encryptedText: string;
    sourceFingerprint: string;
    sourceLine: number;
  }): Promise<{ id: string; inserted: boolean }>;
  listMessages(roomId: string): Promise<StoredMessage[]>;
  replaceAffectedTurns(
    roomId: string,
    affectedMessageIds: string[],
    replacementTurns: TurnToPersist[],
  ): Promise<void>;
}

type DrizzleExecutor = Pick<NodePgDatabase<typeof import("@/db/schema")>, "select" | "insert" | "update" | "delete">;

function createDrizzleOperations(database: DrizzleExecutor): Omit<ImportRepository, "transaction"> {
  return {
    async resolveRoom({ encryptedTitle, existingRoomId }) {
      if (existingRoomId) {
        const existing = await database.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, existingRoomId));
        if (existing.length === 0) throw new Error("Room not found");
        return existingRoomId;
      }
      const created = await database.insert(rooms).values({ encryptedTitle }).returning({ id: rooms.id });
      const roomId = created[0]?.id;
      if (!roomId) throw new Error("Could not create room");
      return roomId;
    },

    async resolveParticipants(roomId, entries) {
      const existing = await database
        .select({ id: participants.id, encryptedName: participants.encryptedName })
        .from(participants)
        .where(eq(participants.roomId, roomId));
      const byName = new Map(existing.map((entry) => [decryptJson<string>(entry.encryptedName), entry.id]));

      for (const entry of entries) {
        if (byName.has(entry.name)) continue;
        const created = await database.insert(participants).values({
          roomId,
          encryptedName: entry.encryptedName,
          isSelf: entry.isSelf,
        }).returning({ id: participants.id });
        const participantId = created[0]?.id;
        if (!participantId) throw new Error("Could not create participant");
        byName.set(entry.name, participantId);
      }
      return byName;
    },

    async insertMessage(input) {
      const created = await database.insert(messages).values(input).onConflictDoNothing({
        target: [messages.roomId, messages.sourceFingerprint],
      }).returning({ id: messages.id });
      const id = created[0]?.id;
      return id ? { id, inserted: true } : { id: "", inserted: false };
    },

    async listMessages(roomId) {
      const rows = await database
        .select({
          id: messages.id,
          participantId: messages.participantId,
          sentAt: messages.sentAt,
          kind: messages.kind,
          encryptedText: messages.encryptedText,
          sourceFingerprint: messages.sourceFingerprint,
          sourceLine: messages.sourceLine,
          encryptedName: participants.encryptedName,
        })
        .from(messages)
        .innerJoin(participants, eq(messages.participantId, participants.id))
        .where(eq(messages.roomId, roomId));
      return rows.map((row) => ({
        id: row.id,
        participantId: row.participantId,
        sentAt: row.sentAt,
        kind: row.kind as MessageKind,
        text: decryptJson<string>(row.encryptedText),
        speaker: decryptJson<string>(row.encryptedName),
        sourceFingerprint: row.sourceFingerprint,
        sourceLine: row.sourceLine,
      }));
    },

    async replaceAffectedTurns(roomId, affectedMessageIds, replacementTurns) {
      if (affectedMessageIds.length === 0) return;
      const existingTurns = await database
        .select({ id: turns.id, encryptedMessageIds: turns.encryptedMessageIds })
        .from(turns)
        .where(eq(turns.roomId, roomId));
      const affected = new Set(affectedMessageIds);
      const affectedExisting = existingTurns.filter((turn) => (
        decryptJson<string[]>(turn.encryptedMessageIds).some((id) => affected.has(id))
      ));
      const available = new Set(affectedExisting.map((turn) => turn.id));
      const existingMessageIds = new Map(affectedExisting.map((turn) => [
        turn.id,
        decryptJson<string[]>(turn.encryptedMessageIds),
      ]));
      const replacementMessageIds = replacementTurns.map((turn) => decryptJson<string[]>(turn.encryptedMessageIds));
      const matches = new Map<number, string>();
      const changedTurnIds = new Set<string>();
      const choose = (replacementIndex: number, predicate: (messageIds: string[]) => boolean) => {
        const match = affectedExisting.find((turn) => available.has(turn.id) && predicate(existingMessageIds.get(turn.id) ?? []));
        if (!match) return false;
        matches.set(replacementIndex, match.id);
        available.delete(match.id);
        return true;
      };
      replacementMessageIds.forEach((messageIds, index) => {
        choose(index, (existingIds) => existingIds.length === messageIds.length && existingIds.every((id, messageIndex) => id === messageIds[messageIndex]));
      });
      replacementMessageIds.forEach((messageIds, index) => {
        if (matches.has(index)) return;
        choose(index, (existingIds) => existingIds[0] !== undefined && existingIds[0] === messageIds[0]);
      });
      replacementMessageIds.forEach((messageIds, index) => {
        if (matches.has(index)) return;
        const match = affectedExisting.filter((turn) => available.has(turn.id)).map((turn) => ({
          id: turn.id,
          overlap: (existingMessageIds.get(turn.id) ?? []).filter((id) => messageIds.includes(id)).length,
        })).filter((entry) => entry.overlap > 0)
          .sort((left, right) => right.overlap - left.overlap || left.id.localeCompare(right.id))[0];
        if (match) {
          matches.set(index, match.id);
          available.delete(match.id);
        }
      });

      for (const [index, replacement] of replacementTurns.entries()) {
        const existingId = matches.get(index);
        if (existingId) {
          const previousIds = existingMessageIds.get(existingId) ?? [];
          if (previousIds.length !== replacementMessageIds[index]!.length || previousIds.some((id, messageIndex) => id !== replacementMessageIds[index]![messageIndex])) {
            changedTurnIds.add(existingId);
          }
          await database.update(turns).set(replacement)
            .where(eq(turns.id, existingId));
        } else {
          const inserted = await database.insert(turns).values({ roomId, ...replacement }).returning({ id: turns.id });
          if (inserted[0]) changedTurnIds.add(inserted[0].id);
        }
      }
      if (available.size > 0) await database.delete(turns).where(inArray(turns.id, [...available]));

      if (changedTurnIds.size > 0) {
        const [orderedTurns, storedChunks] = await Promise.all([
          database.select({ id: turns.id, startedAt: turns.startedAt }).from(turns).where(eq(turns.roomId, roomId)),
          database.select({
            id: chunks.id,
            startTurnId: chunks.startTurnId,
            endTurnId: chunks.endTurnId,
            encryptedSummary: chunks.encryptedSummary,
          }).from(chunks).where(eq(chunks.roomId, roomId)),
        ]);
        orderedTurns.sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime() || left.id.localeCompare(right.id));
        const turnIndexes = new Map(orderedTurns.map((turn, index) => [turn.id, index]));
        const changedIndexes = [...changedTurnIds].flatMap((turnId) => {
          const index = turnIndexes.get(turnId);
          return index === undefined ? [] : [index];
        });
        for (const chunk of storedChunks) {
          const start = turnIndexes.get(chunk.startTurnId);
          const end = turnIndexes.get(chunk.endTurnId);
          if (start === undefined || end === undefined || !changedIndexes.some((index) => index >= start && index <= end)) continue;
          const previous = decryptJson<Record<string, unknown> | string>(chunk.encryptedSummary);
          await database.update(chunks).set({
            encryptedSummary: encryptJson(typeof previous === "string"
              ? { summary: previous, analysisComplete: false }
              : { ...previous, analysisComplete: false }),
            updatedAt: new Date(),
          }).where(and(eq(chunks.roomId, roomId), eq(chunks.id, chunk.id)));
        }
      }
    },
  };
}

/** Production adapter. Tests can provide a small transactional in-memory repository instead of PostgreSQL. */
export function createDrizzleImportRepository(
  database: NodePgDatabase<typeof import("@/db/schema")> = getDb(),
): ImportRepository {
  const operations = createDrizzleOperations(database);
  return {
    ...operations,
    transaction: (work) => database.transaction((transaction) => (
      work({
        ...createDrizzleOperations(transaction as unknown as DrizzleExecutor),
        transaction: async (nestedWork) => nestedWork({
          ...createDrizzleOperations(transaction as unknown as DrizzleExecutor),
          transaction: async () => { throw new Error("Nested import transactions are not supported"); },
        }),
      })
    )),
  };
}

function sortedMessages(messagesToSort: StoredMessage[]): StoredMessage[] {
  return [...messagesToSort].sort((left, right) => (
    left.sentAt.getTime() - right.sentAt.getTime()
    || left.sourceLine - right.sourceLine
    || left.sourceFingerprint.localeCompare(right.sourceFingerprint)
  ));
}

export async function importKakaoExport(
  command: ImportCommand,
  repository: ImportRepository = createDrizzleImportRepository(),
): Promise<ImportSummary> {
  const parsed = parseKakaoExport(command.rawText);
  const title = command.title.trim() || parsed.title;
  const selfName = command.selfName.trim();
  if (!title) throw new Error("Conversation title is required");
  if (!selfName) throw new Error("selfName is required");

  return repository.transaction(async (transaction) => {
    const roomId = await transaction.resolveRoom({
      encryptedTitle: encryptJson(title),
      existingRoomId: command.existingRoomId,
    });
    const names = new Set([...parsed.participants, selfName]);
    const participantIds = await transaction.resolveParticipants(roomId, [...names].map((name) => ({
      name,
      encryptedName: encryptJson(name),
      isSelf: name === selfName,
    })));

    const insertedIds = new Set<string>();
    for (const message of parsed.messages) {
      const participantId = participantIds.get(message.speaker);
      if (!participantId) throw new Error("Could not resolve message participant");
      const result = await transaction.insertMessage({
        roomId,
        participantId,
        sentAt: message.sentAt,
        kind: message.kind,
        encryptedText: encryptJson(message.text),
        sourceFingerprint: message.sourceFingerprint,
        sourceLine: message.sourceLine,
      });
      if (result.inserted) insertedIds.add(result.id);
    }

    if (insertedIds.size > 0) {
      const allMessages = sortedMessages(await transaction.listMessages(roomId));
      const byFingerprint = new Map(allMessages.map((message) => [message.sourceFingerprint, message]));
      const groupedTurns = groupMessageTurns(allMessages);
      const affectedTurnIndexes = new Set<number>();
      groupedTurns.forEach((turn, index) => {
        if (!turn.messages.some((message) => insertedIds.has(byFingerprint.get(message.sourceFingerprint)?.id ?? ""))) return;
        // A late message can split an old neighboring turn. Rebuild its new
        // turn and the immediate new boundaries on both sides, but no more.
        for (let neighbor = Math.max(0, index - 1); neighbor <= Math.min(groupedTurns.length - 1, index + 1); neighbor += 1) {
          affectedTurnIndexes.add(neighbor);
        }
      });
      const affectedTurns = groupedTurns.filter((_, index) => affectedTurnIndexes.has(index));
      const affectedMessageIds = affectedTurns.flatMap((turn) => turn.messages.map((message) => (
        byFingerprint.get(message.sourceFingerprint)?.id
      )).filter((id): id is string => Boolean(id)));
      await transaction.replaceAffectedTurns(roomId, affectedMessageIds, affectedTurns.map((turn) => {
        const participantId = participantIds.get(turn.speaker)
          ?? byFingerprint.get(turn.messages[0]!.sourceFingerprint)?.participantId;
        if (!participantId) throw new Error("Could not resolve turn participant");
        return {
          participantId,
          startedAt: turn.startedAt,
          endedAt: turn.endedAt,
          encryptedMessageIds: encryptJson(turn.messages.map((message) => {
            const messageId = byFingerprint.get(message.sourceFingerprint)?.id;
            if (!messageId) throw new Error("Could not resolve turn message");
            return messageId;
          })),
        };
      }));
    }

    return {
      roomId,
      insertedMessages: insertedIds.size,
      duplicateMessages: parsed.messages.length - insertedIds.size,
      unparsedLines: parsed.unparsedLines,
    };
  });
}
