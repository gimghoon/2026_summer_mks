import { z } from "zod";

import { apiSessionFailure } from "@/domain/auth/session";
import {
  fixtureModeEnabled,
  fixtureRoomCounts,
} from "@/domain/testing/e2e-fixture-store";

export async function GET(request: Request): Promise<Response> {
  const roomId = new URL(request.url).searchParams.get("roomId");
  if (fixtureModeEnabled() && roomId) {
    const sessionFailure = await apiSessionFailure(request);
    if (sessionFailure) return sessionFailure;
    if (!z.string().uuid().safeParse(roomId).success) {
      return new Response("Not found", { status: 404 });
    }
    return Response.json({ status: "ok", counts: fixtureRoomCounts(roomId) });
  }
  return Response.json({ status: "ok" }, {
    headers: { "cache-control": "no-store" },
  });
}
