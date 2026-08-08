import { z } from "zod";

export type RoomRouteContext = { params: Promise<{ roomId: string }> };

export type RoomDeletionDependencies = {
  requireSession: (request: Request) => Promise<void>;
  deleteRoom: (roomId: string) => Promise<boolean>;
  enqueueUploadBlobDeletion: (roomId: string) => Promise<void>;
  log: (event: string, metadata: { roomId: string; failure: string }) => void;
};

const roomIdSchema = z.string().uuid();

/** Testable HTTP boundary; route modules delegate here to satisfy Next's export contract. */
export function createRoomDeleteHandler(dependencies: RoomDeletionDependencies) {
  return async function DELETE(request: Request, context: RoomRouteContext): Promise<Response> {
    try {
      await dependencies.requireSession(request);
    } catch (error) {
      if (error instanceof Response) return error;
      throw error;
    }

    const { roomId } = await context.params;
    if (!roomIdSchema.safeParse(roomId).success) return new Response("Not found", { status: 404 });
    try {
      const deleted = await dependencies.deleteRoom(roomId);
      if (!deleted) return new Response("Not found", { status: 404 });
      await dependencies.enqueueUploadBlobDeletion(roomId);
      dependencies.log("room_deleted", { roomId, failure: "none" });
      return new Response(null, { status: 204 });
    } catch (error) {
      dependencies.log("room_deletion_failed", {
        roomId,
        failure: error instanceof Error ? error.name : "unknown",
      });
      return new Response("Unable to delete room", { status: 500 });
    }
  };
}
