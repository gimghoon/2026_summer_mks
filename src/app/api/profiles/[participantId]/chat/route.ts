import { z } from "zod";

import { apiSessionFailure } from "@/domain/auth/session";
import {
  confirmProfileCorrection,
  proposeProfileCorrection,
} from "@/domain/profiles/profile-service";
import { participantBelongsToRoom } from "@/domain/rooms/participant-scope";
import {
  confirmFixtureCorrection,
  fixtureModeEnabled,
  proposeFixtureCorrection,
} from "@/domain/testing/e2e-fixture-store";
import { readBoundedJson } from "@/lib/http/request-body";

type CorrectionRouteContext = { params: Promise<{ participantId: string }> };
const MAX_CORRECTION_REQUEST_BYTES = 64 * 1024;

const proposeSchema = z.object({
  roomId: z.string().uuid(),
  action: z.literal("propose").optional(),
  userExplanation: z.string().trim().min(1).max(10_000),
});
const confirmSchema = z.object({
  roomId: z.string().uuid(),
  action: z.literal("confirm"),
  proposalId: z.string().min(1),
});
const confirmationSchema = z.object({ roomId: z.string().uuid(), proposalId: z.string().min(1) });

function invalidCorrection(error?: z.ZodError): Response {
  return Response.json({
    error: "Invalid profile correction request",
    ...(error ? { issues: error.flatten() } : {}),
  }, { status: 400 });
}

export async function POST(request: Request, context: CorrectionRouteContext): Promise<Response> {
  const sessionFailure = await apiSessionFailure(request);
  if (sessionFailure) return sessionFailure;
  const { participantId } = await context.params;
  const parsedBody = await readBoundedJson(request, MAX_CORRECTION_REQUEST_BYTES);
  if (!parsedBody.ok) return new Response(
    parsedBody.error === "too_large" ? "Profile correction request is too large" : "Invalid profile correction request",
    { status: parsedBody.error === "too_large" ? 413 : 400 },
  );
  const body = parsedBody.value;

  const confirmation = confirmSchema.safeParse(body);
  if (confirmation.success) {
    if (!await participantBelongsToRoom(confirmation.data.roomId, participantId)) return new Response("Not found", { status: 404 });
    return Response.json(fixtureModeEnabled()
      ? confirmFixtureCorrection(participantId, confirmation.data.proposalId)
      : await confirmProfileCorrection(participantId, confirmation.data.proposalId));
  }
  const proposal = proposeSchema.safeParse(body);
  if (!proposal.success) return invalidCorrection(proposal.error);
  if (!await participantBelongsToRoom(proposal.data.roomId, participantId)) return new Response("Not found", { status: 404 });
  return Response.json(fixtureModeEnabled()
    ? proposeFixtureCorrection(participantId, proposal.data.userExplanation)
    : await proposeProfileCorrection({
      participantId,
      userExplanation: proposal.data.userExplanation,
    }), { status: 201 });
}

/** Explicit second request used by clients that keep proposal and confirmation endpoints separate. */
export async function PATCH(request: Request, context: CorrectionRouteContext): Promise<Response> {
  const sessionFailure = await apiSessionFailure(request);
  if (sessionFailure) return sessionFailure;
  const { participantId } = await context.params;
  const parsedBody = await readBoundedJson(request, MAX_CORRECTION_REQUEST_BYTES);
  if (!parsedBody.ok) return new Response(
    parsedBody.error === "too_large" ? "Profile correction request is too large" : "Invalid profile correction request",
    { status: parsedBody.error === "too_large" ? 413 : 400 },
  );
  const body = parsedBody.value;
  const parsed = confirmationSchema.safeParse(body);
  if (!parsed.success) return invalidCorrection(parsed.error);
  if (!await participantBelongsToRoom(parsed.data.roomId, participantId)) return new Response("Not found", { status: 404 });
  return Response.json(fixtureModeEnabled()
    ? confirmFixtureCorrection(participantId, parsed.data.proposalId)
    : await confirmProfileCorrection(participantId, parsed.data.proposalId));
}
