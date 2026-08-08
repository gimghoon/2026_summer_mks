import "server-only";

import { desc, eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { chunks, participants, roomMemories, rooms } from "@/db/schema";
import { decryptJson } from "@/domain/crypto/encrypted-json";
import {
  fixtureModeEnabled,
  getFixtureRoom,
  listFixtureRooms,
} from "@/domain/testing/e2e-fixture-store";
import type { RoomParticipantView, RoomView } from "./room-read-types";

export type { RoomParticipantView, RoomView } from "./room-read-types";

function readableRoom(row: { id: string; encryptedTitle: string; updatedAt: Date }, participantRows: RoomParticipantView[], analysisStatus: RoomView["analysisStatus"]): RoomView {
  return { id: row.id, title: decryptJson<string>(row.encryptedTitle), updatedAt: row.updatedAt.toISOString(), participants: participantRows, analysisStatus };
}

/** Private page read model. Authentication stays at the Server Component boundary. */
export async function listRoomViews(): Promise<RoomView[]> {
  if (fixtureModeEnabled()) return listFixtureRooms();
  const database = getDb();
  const roomRows = await database.select({ id: rooms.id, encryptedTitle: rooms.encryptedTitle, updatedAt: rooms.updatedAt }).from(rooms).orderBy(desc(rooms.updatedAt));
  if (!roomRows.length) return [];
  const participantRows = await database.select({ id: participants.id, roomId: participants.roomId, encryptedName: participants.encryptedName, isSelf: participants.isSelf, relationshipStyle: participants.relationshipStyle }).from(participants);
  const memoryRows = await database.select({ roomId: roomMemories.roomId }).from(roomMemories);
  const chunkRows = await database.select({ roomId: chunks.roomId, encryptedSummary: chunks.encryptedSummary }).from(chunks);
  const ready = new Set(memoryRows.map((row) => row.roomId)); const byRoom = Map.groupBy(chunkRows, (row) => row.roomId);
  return roomRows.map((room) => { const roomChunks = byRoom.get(room.id) ?? []; const complete = roomChunks.length > 0 && roomChunks.every((chunk) => { const payload = decryptJson<{ analysisComplete?: boolean } | string>(chunk.encryptedSummary); return typeof payload !== "string" && payload.analysisComplete === true; }); return readableRoom(room, participantRows.filter((participant) => participant.roomId === room.id).map((participant) => ({ id: participant.id, name: decryptJson<string>(participant.encryptedName), isSelf: participant.isSelf, relationshipStyle: participant.relationshipStyle })), ready.has(room.id) && complete ? "ready" : "needs_analysis"); });
}

export async function getRoomView(roomId: string): Promise<RoomView | null> {
  if (fixtureModeEnabled()) return getFixtureRoom(roomId);
  const database = getDb();
  const rows = await database.select({ id: rooms.id, encryptedTitle: rooms.encryptedTitle, updatedAt: rooms.updatedAt }).from(rooms).where(eq(rooms.id, roomId));
  const room = rows[0];
  if (!room) return null;
  const [participantRows, memoryRows, chunkRows] = await Promise.all([
    database.select({ id: participants.id, encryptedName: participants.encryptedName, isSelf: participants.isSelf, relationshipStyle: participants.relationshipStyle }).from(participants).where(eq(participants.roomId, roomId)),
    database.select({ roomId: roomMemories.roomId }).from(roomMemories).where(eq(roomMemories.roomId, roomId)),
    database.select({ roomId: chunks.roomId, encryptedSummary: chunks.encryptedSummary }).from(chunks).where(eq(chunks.roomId, roomId)),
  ]);
  const complete = chunkRows.length > 0 && chunkRows.every((chunk) => { const payload = decryptJson<{ analysisComplete?: boolean } | string>(chunk.encryptedSummary); return typeof payload !== "string" && payload.analysisComplete === true; });
  return readableRoom(room, participantRows.map((participant) => ({ id: participant.id, name: decryptJson<string>(participant.encryptedName), isSelf: participant.isSelf, relationshipStyle: participant.relationshipStyle })), memoryRows.length > 0 && complete ? "ready" : "needs_analysis");
}
