import { asc, eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { chunks, turns } from "@/db/schema";
import { encryptJson } from "@/domain/crypto/encrypted-json";
import { chunkTurns } from "./chunker";
import { extractRoomMemory } from "./extractor";

const EMPTY_VECTOR = Array<number>(1536).fill(0);

/** Builds deterministic time chunks once, then retries only incomplete extraction work. */
export async function analyzeImportedRoom(roomId: string) {
  const database = getDb();
  const existing = await database.select({ id: chunks.id }).from(chunks).where(eq(chunks.roomId, roomId));
  if (existing.length === 0) {
    const storedTurns = await database.select({ id: turns.id, startedAt: turns.startedAt, endedAt: turns.endedAt })
      .from(turns).where(eq(turns.roomId, roomId)).orderBy(asc(turns.startedAt));
    const planned = chunkTurns(storedTurns.map((turn) => ({ speaker: "", startedAt: turn.startedAt, endedAt: turn.endedAt, messages: [] })), []);
    if (planned.length) await database.insert(chunks).values(planned.map((chunk) => ({
      roomId,
      startTurnId: storedTurns[chunk.startTurnIndex]!.id,
      endTurnId: storedTurns[chunk.endTurnIndex]!.id,
      startedAt: chunk.startedAt,
      endedAt: chunk.endedAt,
      encryptedSummary: encryptJson({ analysisComplete: false }),
      encryptedTopicTags: encryptJson<string[]>([]),
      encryptedEventTypes: encryptJson<string[]>([]),
      embedding: EMPTY_VECTOR,
    })));
  }
  return extractRoomMemory(roomId);
}
