// @vitest-environment node

import { hash } from "@node-rs/argon2";

const importKakaoExportMock = vi.hoisted(() => vi.fn());
const UnsupportedKakaoExportErrorMock = vi.hoisted(() => class UnsupportedKakaoExportError extends Error {});

vi.mock("@/domain/imports/import-service", () => ({
  importKakaoExport: importKakaoExportMock,
  UnsupportedKakaoExportError: UnsupportedKakaoExportErrorMock,
}));

import { POST } from "@/app/api/imports/route";
import { createSessionCookie } from "@/domain/auth/session";
import { MAX_IMPORT_FILE_BYTES, MAX_IMPORT_REQUEST_BYTES } from "@/domain/imports/import-limits";

const databaseUrl = "postgresql://postgres:postgres@localhost:5432/private_reply_assistant";
const password = "local-test-password";
let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hash(password);
});

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", databaseUrl);
  vi.stubEnv("APP_PASSWORD_HASH", passwordHash);
  vi.stubEnv("SESSION_SIGNING_KEY", Buffer.alloc(32, 13).toString("base64"));
  vi.stubEnv("APP_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  importKakaoExportMock.mockReset();
});

afterEach(() => vi.unstubAllEnvs());

const multipartBoundary = "import-boundary";
const encoder = new TextEncoder();

function multipartBody(
  selfName: string | undefined,
  file: Uint8Array,
  existingRoomId?: string,
  filename = "chat.txt",
  contentType = "text/plain",
): ArrayBuffer {
  const parts: Uint8Array[] = [];
  if (selfName !== undefined) {
    parts.push(encoder.encode(
      `--${multipartBoundary}\r\nContent-Disposition: form-data; name="selfName"\r\n\r\n${selfName}\r\n`,
    ));
  }
  if (existingRoomId !== undefined) {
    parts.push(encoder.encode(
      `--${multipartBoundary}\r\nContent-Disposition: form-data; name="existingRoomId"\r\n\r\n${existingRoomId}\r\n`,
    ));
  }
  parts.push(encoder.encode(
    `--${multipartBoundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  ));
  parts.push(file, encoder.encode(`\r\n--${multipartBoundary}--\r\n`));
  const totalBytes = parts.reduce((total, part) => total + part.byteLength, 0);
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return body.buffer;
}

async function authenticatedRequest(body: BodyInit, contentType = `multipart/form-data; boundary=${multipartBoundary}`): Promise<Request> {
  const cookie = (await createSessionCookie(password)).split(";", 1)[0]!;
  return new Request("https://assistant.test/api/imports", {
    method: "POST",
    headers: { cookie, "content-type": contentType },
    body,
  });
}

test("returns Zod validation errors for a missing selfName", async () => {
  const response = await POST(await authenticatedRequest(
    multipartBody(undefined, encoder.encode("대화방 카카오톡 대화")),
  ));

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({ error: "Invalid import request" });
});

test("returns 400 for malformed multipart below the request cap", async () => {
  const response = await POST(await authenticatedRequest("this is not multipart"));

  expect(response.status).toBe(400);
  expect(importKakaoExportMock).not.toHaveBeenCalled();
});

test("rejects an over-limit content-length before multipart parsing", async () => {
  const cookie = (await createSessionCookie(password)).split(";", 1)[0]!;
  const request = new Request("https://assistant.test/api/imports", {
    method: "POST",
    headers: {
      cookie,
      "content-type": "multipart/form-data; boundary=import-boundary",
      "content-length": String(MAX_IMPORT_REQUEST_BYTES + 1),
    },
    body: "--import-boundary--\r\n",
  });

  const response = await POST(request);

  expect(response.status).toBe(413);
  expect(importKakaoExportMock).not.toHaveBeenCalled();
});

test("rejects an over-limit multipart stream before multipart parsing", async () => {
  const cookie = (await createSessionCookie(password)).split(";", 1)[0]!;
  const request = new Request("https://assistant.test/api/imports", {
    method: "POST",
    headers: { cookie, "content-type": "multipart/form-data; boundary=import-boundary" },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_IMPORT_REQUEST_BYTES + 1));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  const response = await POST(request);

  expect(response.status).toBe(413);
  expect(importKakaoExportMock).not.toHaveBeenCalled();
});

test("refuses a multipart file larger than 50 MiB after bounded decoding", async () => {
  const response = await POST(await authenticatedRequest(
    multipartBody("지훈", new Uint8Array(MAX_IMPORT_FILE_BYTES + 1)),
  ));

  expect(response.status).toBe(413);
  expect(importKakaoExportMock).not.toHaveBeenCalled();
});

test("passes a validated existing room UUID to the import service", async () => {
  const existingRoomId = "11111111-1111-4111-8111-111111111111";
  importKakaoExportMock.mockResolvedValue({ roomId: existingRoomId, insertedMessages: 1, duplicateMessages: 0, unparsedLines: [] });
  const response = await POST(await authenticatedRequest(multipartBody(
    "지훈",
    encoder.encode("민수와 카카오톡 대화\n2026년 8월 7일 오전 9:01, 민수 : 안녕"),
    existingRoomId,
  )));

  expect(response.status).toBe(201);
  expect(importKakaoExportMock).toHaveBeenCalledWith(expect.objectContaining({ existingRoomId }));
});

test("accepts a valid CSV and removes the csv extension from the room title", async () => {
  importKakaoExportMock.mockResolvedValue({
    roomId: "11111111-1111-4111-8111-111111111111",
    insertedMessages: 1,
    duplicateMessages: 0,
    unparsedLines: [],
  });
  const csv = encoder.encode("Date,User,Message\n2026-08-07 09:01:02,민수,안녕");
  const response = await POST(await authenticatedRequest(
    multipartBody("지훈", csv, undefined, "목요일 모임.csv", "text/csv"),
  ));

  expect(response.status).toBe(201);
  expect(importKakaoExportMock).toHaveBeenCalledWith(expect.objectContaining({
    title: "목요일 모임",
    rawText: expect.stringContaining("Date,User,Message"),
  }));
});

test("returns 400 without importing when no valid messages are parsed", async () => {
  const body = multipartBody(
    "지훈",
    encoder.encode("Date,User,Other\n2026-08-07 09:01:02,민수,안녕"),
    undefined,
    "unsupported.csv",
    "text/csv",
  );
  const response = await POST(await authenticatedRequest(body));

  expect(response.status).toBe(400);
  expect(importKakaoExportMock).not.toHaveBeenCalled();
});

test("returns 400 when the import service rejects an unsupported export", async () => {
  importKakaoExportMock.mockRejectedValue(new UnsupportedKakaoExportErrorMock());
  const response = await POST(await authenticatedRequest(multipartBody(
    "지훈",
    encoder.encode("민수와 카카오톡 대화\n2026년 8월 7일 오전 9:01, 민수 : 안녕"),
  )));

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({
    error: "지원하는 카카오톡 대화 형식이 아니거나 메시지가 없어요.",
  });
});

test("rejects a malformed existing room ID before import", async () => {
  const response = await POST(await authenticatedRequest(multipartBody(
    "지훈",
    encoder.encode("민수와 카카오톡 대화\n2026년 8월 7일 오전 9:01, 민수 : 안녕"),
    "not-a-uuid",
  )));

  expect(response.status).toBe(400);
  expect(importKakaoExportMock).not.toHaveBeenCalled();
});

test("returns not found when the validated existing room no longer exists", async () => {
  const existingRoomId = "11111111-1111-4111-8111-111111111111";
  importKakaoExportMock.mockRejectedValue(new Error("Room not found"));
  const response = await POST(await authenticatedRequest(multipartBody(
    "지훈",
    encoder.encode("민수와 카카오톡 대화\n2026년 8월 7일 오전 9:01, 민수 : 안녕"),
    existingRoomId,
  )));

  expect(response.status).toBe(404);
});
