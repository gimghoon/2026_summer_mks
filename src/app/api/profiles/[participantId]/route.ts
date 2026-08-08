import { z } from "zod";

import { apiSessionFailure } from "@/domain/auth/session";
import {
  applyProfileEdit,
  listProfileFacts,
  profileFactKinds,
} from "@/domain/profiles/profile-service";
import { participantBelongsToRoom } from "@/domain/rooms/participant-scope";
import {
  editFixtureProfileFact,
  fixtureModeEnabled,
  listFixtureProfileFacts,
} from "@/domain/testing/e2e-fixture-store";
import { readBoundedJson } from "@/lib/http/request-body";

type ProfileRouteContext = { params: Promise<{ participantId: string }> };
const MAX_PROFILE_REQUEST_BYTES = 64 * 1024;

const profileEditSchema = z.object({
  roomId: z.string().uuid(),
  factId: z.string().min(1).optional(),
  kind: z.enum(profileFactKinds),
  value: z.string().trim().min(1).max(10_000),
  conditions: z.array(z.string().max(1_000)).max(50).default([]),
  exceptions: z.array(z.string().max(1_000)).max(50).default([]),
  action: z.enum(["edit", "confirm"]),
});

function invalidRequest(error: z.ZodError): Response {
  return Response.json({ error: "Invalid profile request", issues: error.flatten() }, { status: 400 });
}

export async function GET(request: Request, context: ProfileRouteContext): Promise<Response> {
  const sessionFailure = await apiSessionFailure(request);
  if (sessionFailure) return sessionFailure;
  const { participantId } = await context.params;
  const roomId = new URL(request.url).searchParams.get("roomId");
  if (!roomId || !z.string().uuid().safeParse(roomId).success) return new Response("Not found", { status: 404 });
  if (!await participantBelongsToRoom(roomId, participantId)) return new Response("Not found", { status: 404 });
  return Response.json({
    participantId,
    facts: fixtureModeEnabled()
      ? listFixtureProfileFacts(participantId)
      : await listProfileFacts(participantId),
  });
}

export async function PATCH(request: Request, context: ProfileRouteContext): Promise<Response> {
  const sessionFailure = await apiSessionFailure(request);
  if (sessionFailure) return sessionFailure;
  const { participantId } = await context.params;
  const body = await readBoundedJson(request, MAX_PROFILE_REQUEST_BYTES);
  if (!body.ok) {
    return Response.json({ error: body.error === "too_large" ? "Profile request is too large" : "Invalid profile request" }, {
      status: body.error === "too_large" ? 413 : 400,
    });
  }
  const parsed = profileEditSchema.safeParse(body.value);
  if (!parsed.success) return invalidRequest(parsed.error);
  if (!await participantBelongsToRoom(parsed.data.roomId, participantId)) return new Response("Not found", { status: 404 });
  const fact = fixtureModeEnabled()
    ? editFixtureProfileFact({ participantId, ...parsed.data })
    : await applyProfileEdit({ participantId, ...parsed.data });
  return Response.json(fact);
}
