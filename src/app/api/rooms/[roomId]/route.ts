import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { rooms } from "@/db/schema";
import { requireSession } from "@/domain/auth/session";
import {
  createRoomDeleteHandler,
  type RoomDeletionDependencies,
} from "@/domain/rooms/room-deletion-api-handler";
import { safeLog } from "@/lib/logger";

function productionDependencies(): RoomDeletionDependencies {
  return {
    requireSession,
    async deleteRoom(roomId) {
      return getDb().transaction(async (transaction) => {
        const deleted = await transaction.delete(rooms).where(eq(rooms.id, roomId)).returning({ id: rooms.id });
        return deleted.length === 1;
      });
    },
    // Imports are parsed and stored in PostgreSQL; no upload blobs are persisted
    // by the current schema, so there are no associated keys to enqueue yet.
    async enqueueUploadBlobDeletion() {},
    log: safeLog,
  };
}

export const DELETE = createRoomDeleteHandler(productionDependencies());
