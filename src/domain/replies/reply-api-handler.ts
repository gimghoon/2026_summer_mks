import { z } from "zod";

import {
  ReplyGenerationValidationError,
  type GenerateRepliesCommand,
  type ReplyCandidate,
  type ReplyGenerationResult,
} from "@/domain/replies/reply-service";
import type { IndirectnessLevel } from "@/domain/replies/style-policy";
import type { RelationshipStyle } from "@/db/schema";
import { err, ok, type Result } from "@/lib/result";

const MAX_REPLY_REQUEST_BYTES = 512 * 1024;
export const MAX_PASTED_CONVERSATION_CHARACTERS = 50_000;
const DEFAULT_INDIRECTNESS: IndirectnessLevel = 3;

const replyBodySchema = z.object({
  roomId: z.string().uuid(),
  participantId: z.string().uuid(),
  pastedConversation: z.string().min(1).max(MAX_PASTED_CONVERSATION_CHARACTERS),
  situation: z.string().trim().min(1).max(2_000),
  intent: z.string().trim().min(1).max(1_000),
  indirectness: z.number().int().min(1).max(7).optional(),
  relationship: z.enum(["female_friend", "girlfriend"]).optional(),
}).strict();

export type ReplyBody = z.infer<typeof replyBodySchema>;

export type ReplyRouteDependencies = {
  requireSession: (request: Request) => Promise<void>;
  isRoomReady: (roomId: string) => Promise<boolean>;
  loadParticipant: (input: Pick<ReplyBody, "roomId" | "participantId">) => Promise<{
    relationship: RelationshipStyle;
  } | null>;
  generate: (command: GenerateRepliesCommand, relationship: RelationshipStyle) => Promise<ReplyGenerationResult>;
  persist: (input: {
    command: GenerateRepliesCommand;
    relationship: RelationshipStyle;
    candidates: [ReplyCandidate, ReplyCandidate, ReplyCandidate];
  }) => Promise<void>;
  log: (event: string, metadata: { roomId: string; participantId: string; failure: string }) => void;
};

type ParseFailure = "invalid" | "too_large";

function invalidRequest(error?: z.ZodError): Response {
  return Response.json({
    error: "Invalid reply request",
    ...(error ? { issues: error.flatten() } : {}),
  }, { status: 400 });
}

function declaredBodyIsTooLarge(request: Request): boolean {
  const contentLength = request.headers.get("content-length");
  return Boolean(contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > MAX_REPLY_REQUEST_BYTES);
}

async function parseReplyBody(request: Request): Promise<Result<ReplyBody, ParseFailure | z.ZodError>> {
  if (declaredBodyIsTooLarge(request)) return err("too_large");
  if (!request.body) return err("invalid");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_REPLY_REQUEST_BYTES) {
        await reader.cancel();
        return err("too_large");
      }
      chunks.push(value);
    }
  } catch {
    return err("invalid");
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = replyBodySchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
    return parsed.success ? ok(parsed.data) : err(parsed.error);
  } catch {
    return err("invalid");
  }
}

/** Testable HTTP boundary; route modules delegate here to satisfy Next's export contract. */
export function createReplyPostHandler(dependencies: ReplyRouteDependencies) {
  return async function POST(request: Request): Promise<Response> {
    try {
      await dependencies.requireSession(request);
    } catch (error) {
      if (error instanceof Response) return error;
      throw error;
    }

    const parsed = await parseReplyBody(request);
    if (!parsed.ok) {
      return parsed.error === "too_large"
        ? new Response("Reply request is too large", { status: 413 })
        : invalidRequest(parsed.error === "invalid" ? undefined : parsed.error);
    }
    const body = parsed.value;
    if (!await dependencies.isRoomReady(body.roomId)) {
      return Response.json({ error: "ANALYSIS_REQUIRED" }, { status: 409 });
    }
    const participant = await dependencies.loadParticipant(body);
    if (!participant) return new Response("Not found", { status: 404 });

    const command: GenerateRepliesCommand = {
      roomId: body.roomId,
      participantId: body.participantId,
      pastedConversation: body.pastedConversation,
      situation: body.situation,
      intent: body.intent,
      indirectness: (body.indirectness as IndirectnessLevel | undefined) ?? DEFAULT_INDIRECTNESS,
      personalContextMode: "normal",
    };
    try {
      const relationship = body.relationship ?? participant.relationship;
      const result = await dependencies.generate(command, relationship);
      if (result.kind === "clarification_required") return Response.json(result, { status: 409 });
      if (result.kind === "personal_context_unavailable") return Response.json(result, { status: 409 });
      await dependencies.persist({ command, relationship, candidates: result.candidates });
      return Response.json({ candidates: result.candidates });
    } catch (error) {
      dependencies.log("reply_request_failed", {
        roomId: body.roomId,
        participantId: body.participantId,
        failure: error instanceof ReplyGenerationValidationError
          ? `${error.name}:${error.ruleIds.join("|")}`
          : error instanceof Error ? error.name : "unknown",
      });
      return new Response("Unable to generate replies", { status: 500 });
    }
  };
}
