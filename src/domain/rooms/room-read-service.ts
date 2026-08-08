import "server-only";

import { desc, eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { participants, rooms } from "@/db/schema";
import { decryptJson } from "@/domain/crypto/encrypted-json";
import type { RoomParticipantView, RoomView } from "./room-read-types";

export type { RoomParticipantView, RoomView } from "./room-read-types";

function readableRoom(row: { id: string; encryptedTitle: string; updatedAt: Date }, participantRows: RoomParticipantView[]): RoomView {
  return { id: row.id, title: decryptJson<string>(row.encryptedTitle), updatedAt: row.updatedAt.toISOString(), participants: participantRows };
}

/** Private page read model. Authentication stays at the Server Component boundary. */
export async function listRoomViews(): Promise<RoomView[]> {
  const database = getDb();
  const roomRows = await database.select({ id: rooms.id, encryptedTitle: rooms.encryptedTitle, updatedAt: rooms.updatedAt }).from(rooms).orderBy(desc(rooms.updatedAt));
  if (!roomRows.length) return [];
  const participantRows = await database.select({ id: participants.id, roomId: participants.roomId, encryptedName: participants.encryptedName, isSelf: participants.isSelf, relationshipStyle: participants.relationshipStyle }).from(participants);
  return roomRows.map((room) => readableRoom(room, participantRows.filter((participant) => participant.roomId === room.id).map((participant) => ({ id: participant.id, name: decryptJson<string>(participant.encryptedName), isSelf: participant.isSelf, relationshipStyle: participant.relationshipStyle }))));
}

export async function getRoomView(roomId: string): Promise<RoomView | null> {
  const database = getDb();
  const rows = await database.select({ id: rooms.id, encryptedTitle: rooms.encryptedTitle, updatedAt: rooms.updatedAt }).from(rooms).where(eq(rooms.id, roomId));
  const room = rows[0];
  if (!room) return null;
  const participantRows = await database.select({ id: participants.id, encryptedName: participants.encryptedName, isSelf: participants.isSelf, relationshipStyle: participants.relationshipStyle }).from(participants).where(eq(participants.roomId, roomId));
  return readableRoom(room, participantRows.map((participant) => ({ id: participant.id, name: decryptJson<string>(participant.encryptedName), isSelf: participant.isSelf, relationshipStyle: participant.relationshipStyle })));
}
