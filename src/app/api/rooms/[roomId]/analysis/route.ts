import { count, eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { chunks, rooms } from "@/db/schema";
import { apiSessionFailure } from "@/domain/auth/session";
import {
  analyzeImportedRoom,
  getRoomAnalysisProgress,
} from "@/domain/memory/room-analysis-orchestrator";
import { getRoomView } from "@/domain/rooms/room-read-service";
import {
  analyzeFixtureRoom,
  fixtureModeEnabled,
} from "@/domain/testing/e2e-fixture-store";

type Context = { params: Promise<{ roomId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const sessionFailure = await apiSessionFailure(request);
  if (sessionFailure) return sessionFailure;
  const { roomId } = await context.params;
  const room = await getRoomView(roomId);
  if (!room) return new Response("Not found", { status: 404 });
  if (fixtureModeEnabled()) {
    return Response.json({
      roomId,
      status: room.analysisStatus === "ready" ? "ready" : "pending",
      stage: room.analysisStatus === "ready" ? "complete" : "chunks",
      completedChunks: room.analysisStatus === "ready" ? 1 : 0,
      totalChunks: 1,
      failure: "none",
    });
  }
  const stored = await getRoomAnalysisProgress(roomId);
  if (stored && !(stored.status === "ready" && room.analysisStatus === "needs_analysis")) {
    return Response.json(stored);
  }
  const rows = await getDb().select({ total: count() }).from(chunks).where(eq(chunks.roomId, roomId));
  const totalChunks = rows[0]?.total ?? 0;
  if (stored?.status === "ready") {
    return Response.json({
      roomId,
      status: "pending",
      stage: "chunks",
      completedChunks: 0,
      totalChunks,
      failure: "none",
    });
  }
  return Response.json({
    roomId,
    status: room.analysisStatus === "ready" ? "ready" : "pending",
    stage: room.analysisStatus === "ready" ? "complete" : "chunks",
    completedChunks: room.analysisStatus === "ready" ? totalChunks : 0,
    totalChunks,
    failure: "none",
  });
}

/** Retry-safe analysis hook: incomplete chunks remain pending until extraction completes. */
export async function POST(request: Request, context: Context): Promise<Response> {
  const sessionFailure = await apiSessionFailure(request);
  if (sessionFailure) return sessionFailure;
  const { roomId } = await context.params;
  if (fixtureModeEnabled()) {
    const result = analyzeFixtureRoom(roomId);
    if (!result) return new Response("Not found", { status: 404 });
    return Response.json({ roomId, status: "ready", ...result });
  }
  const found = await getDb().select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId));
  if (!found[0]) return new Response("Not found", { status: 404 });
  try {
    const result = await analyzeImportedRoom(roomId);
    const room = await getRoomView(roomId);
    return Response.json({ roomId, status: room?.analysisStatus ?? "needs_analysis", updatedChunks: result.updatedChunkIds.length });
  } catch {
    return new Response("Unable to analyze room", { status: 503 });
  }
}
