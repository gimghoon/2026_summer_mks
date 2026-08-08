import { z } from "zod";

import { requireSession } from "@/domain/auth/session";
import {
  confirmProfileCorrection,
  proposeProfileCorrection,
} from "@/domain/profiles/profile-service";

type CorrectionRouteContext = { params: Promise<{ participantId: string }> };

const proposeSchema = z.object({
  action: z.literal("propose").optional(),
  userExplanation: z.string().trim().min(1),
});
const confirmSchema = z.object({
  action: z.literal("confirm"),
  proposalId: z.string().min(1),
});
const confirmationSchema = z.object({ proposalId: z.string().min(1) });

function invalidCorrection(error?: z.ZodError): Response {
  return Response.json({
    error: "Invalid profile correction request",
    ...(error ? { issues: error.flatten() } : {}),
  }, { status: 400 });
}

export async function POST(request: Request, context: CorrectionRouteContext): Promise<Response> {
  await requireSession(request);
  const { participantId } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidCorrection();
  }

  const confirmation = confirmSchema.safeParse(body);
  if (confirmation.success) {
    return Response.json(await confirmProfileCorrection(participantId, confirmation.data.proposalId));
  }
  const proposal = proposeSchema.safeParse(body);
  if (!proposal.success) return invalidCorrection(proposal.error);
  return Response.json(await proposeProfileCorrection({
    participantId,
    userExplanation: proposal.data.userExplanation,
  }), { status: 201 });
}

/** Explicit second request used by clients that keep proposal and confirmation endpoints separate. */
export async function PATCH(request: Request, context: CorrectionRouteContext): Promise<Response> {
  await requireSession(request);
  const { participantId } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidCorrection();
  }
  const parsed = confirmationSchema.safeParse(body);
  if (!parsed.success) return invalidCorrection(parsed.error);
  return Response.json(await confirmProfileCorrection(participantId, parsed.data.proposalId));
}
