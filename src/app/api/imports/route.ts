import { z } from "zod";

import { apiSessionFailure } from "@/domain/auth/session";
import {
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_REQUEST_BYTES,
} from "@/domain/imports/import-limits";
import {
  importKakaoExport,
  UnsupportedKakaoExportError,
} from "@/domain/imports/import-service";
import { parseKakaoExport } from "@/domain/kakao/parser";
import {
  fixtureModeEnabled,
  importFixtureRoom,
} from "@/domain/testing/e2e-fixture-store";

const importFormSchema = z.object({
  selfName: z.string().trim().min(1, "selfName is required"),
  existingRoomId: z.preprocess(
    (value) => value === "" || value === null ? undefined : value,
    z.string().uuid().optional(),
  ),
});

class ImportBodyTooLargeError extends Error {}

function badRequest(error: z.ZodError): Response {
  return Response.json({ error: "Invalid import request", issues: error.flatten() }, { status: 400 });
}

function declaredBodyIsTooLarge(request: Request): boolean {
  const contentLength = request.headers.get("content-length");
  if (!contentLength || !/^\d+$/.test(contentLength)) return false;
  return Number(contentLength) > MAX_IMPORT_REQUEST_BYTES;
}

async function boundedMultipartRequest(request: Request): Promise<Request> {
  if (declaredBodyIsTooLarge(request)) throw new ImportBodyTooLargeError();
  if (!request.body) return request;

  const reader = request.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_IMPORT_REQUEST_BYTES) {
      await reader.cancel();
      throw new ImportBodyTooLargeError();
    }
    const copied = new Uint8Array(value.byteLength);
    copied.set(value);
    chunks.push(copied.buffer);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: body.buffer,
  });
}

function isMultipartOversizeError(error: unknown): boolean {
  if (error instanceof ImportBodyTooLargeError) return true;
  return error instanceof Error && /(?:too large|too big|larger than|exceeds?|limit|size)/i.test(error.message);
}

export async function POST(request: Request): Promise<Response> {
  const sessionFailure = await apiSessionFailure(request);
  if (sessionFailure) return sessionFailure;

  let formData: FormData;
  try {
    formData = await (await boundedMultipartRequest(request)).formData();
  } catch (error) {
    if (isMultipartOversizeError(error)) {
      return new Response("Import file is too large", { status: 413 });
    }
    return Response.json({ error: "Invalid import request" }, { status: 400 });
  }

  const form = importFormSchema.safeParse({
    selfName: formData.get("selfName"),
    existingRoomId: formData.get("existingRoomId"),
  });
  if (!form.success) return badRequest(form.error);

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "Invalid import request", issues: { formErrors: ["file is required"] } }, { status: 400 });
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    return new Response("Import file is too large", { status: 413 });
  }

  const rawText = await file.text();
  const parsed = parseKakaoExport(rawText);
  const title = parsed.title || file.name.replace(/\.(?:txt|csv)$/i, "");
  if (parsed.messages.length === 0) {
    return Response.json(
      { error: "지원하는 카카오톡 대화 형식이 아니거나 메시지가 없어요." },
      { status: 400 },
    );
  }
  if (!title) {
    return Response.json({ error: "Invalid import request", issues: { formErrors: ["conversation title is required"] } }, { status: 400 });
  }

  let summary;
  try {
    summary = fixtureModeEnabled()
      ? importFixtureRoom({
        title,
        selfName: form.data.selfName,
        rawText,
        existingRoomId: form.data.existingRoomId,
      })
      : await importKakaoExport({
        title,
        selfName: form.data.selfName,
        rawText,
        existingRoomId: form.data.existingRoomId,
      });
  } catch (error) {
    if (error instanceof UnsupportedKakaoExportError) {
      return Response.json(
        { error: "지원하는 카카오톡 대화 형식이 아니거나 메시지가 없어요." },
        { status: 400 },
      );
    }
    if (error instanceof Error && error.message === "Room not found") {
      return new Response("Not found", { status: 404 });
    }
    throw error;
  }
  return Response.json(summary, { status: 201 });
}
