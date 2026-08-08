import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { participants } from "@/db/schema";
import {
  fixtureModeEnabled,
  fixtureParticipantBelongsToRoom,
} from "@/domain/testing/e2e-fixture-store";

/** Ensures every profile read/write is scoped to its room URL. */
export async function participantBelongsToRoom(roomId: string, participantId: string): Promise<boolean> {
  if (fixtureModeEnabled()) return fixtureParticipantBelongsToRoom(roomId, participantId);
  const rows = await getDb().select({ id: participants.id }).from(participants)
    .where(and(eq(participants.id, participantId), eq(participants.roomId, roomId)));
  return rows.length === 1;
}
