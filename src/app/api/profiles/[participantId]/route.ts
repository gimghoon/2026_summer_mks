import { z } from "zod";

import { requireSession } from "@/domain/auth/session";
import {
  applyProfileEdit,
  listProfileFacts,
  profileFactKinds,
} from "@/domain/profiles/profile-service";

type ProfileRouteContext = { params: Promise<{ participantId: string }> };

const profileEditSchema = z.object({
  factId: z.string().min(1).optional(),
  kind: z.enum(profileFactKinds),
  value: z.string().trim().min(1),
  conditions: z.array(z.string()).default([]),
  exceptions: z.array(z.string()).default([]),
  action: z.enum(["edit", "confirm"]),
});

function invalidRequest(error: z.ZodError): Response {
  return Response.json({ error: "Invalid profile request", issues: error.flatten() }, { status: 400 });
}

export async function GET(request: Request, context: ProfileRouteContext): Promise<Response> {
  await requireSession(request);
  const { participantId } = await context.params;
  return Response.json({ participantId, facts: await listProfileFacts(participantId) });
}

export async function PATCH(request: Request, context: ProfileRouteContext): Promise<Response> {
  await requireSession(request);
  const { participantId } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid profile request" }, { status: 400 });
  }
  const parsed = profileEditSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  const fact = await applyProfileEdit({ participantId, ...parsed.data });
  return Response.json(fact);
}
