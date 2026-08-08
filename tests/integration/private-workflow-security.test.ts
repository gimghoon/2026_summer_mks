// @vitest-environment node

import { hash } from "@node-rs/argon2";

import { POST as importRoom } from "@/app/api/imports/route";
import { POST as reply } from "@/app/api/replies/route";
import { POST as login } from "@/app/api/session/route";
import { POST as correctProfile } from "@/app/api/profiles/[participantId]/chat/route";
import { PATCH as editProfile } from "@/app/api/profiles/[participantId]/route";
import { createSessionCookie } from "@/domain/auth/session";
import {
  analyzeFixtureRoom,
  deleteFixtureRoom,
  fixtureParticipantBelongsToRoom,
  fixtureRoomCounts,
  fixtureStoredPayloads,
  getFixtureRoom,
  importFixtureRoom,
} from "@/domain/testing/e2e-fixture-store";

const databaseUrl = "postgresql://postgres:postgres@localhost:5432/private_reply_assistant";
const password = "private-security-test-password";
const participantId = "22222222-2222-4222-8222-222222222222";
let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hash(password);
});

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", databaseUrl);
  vi.stubEnv("APP_PASSWORD_HASH", passwordHash);
  vi.stubEnv("SESSION_SIGNING_KEY", Buffer.alloc(32, 13).toString("base64"));
  vi.stubEnv("APP_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
});

afterEach(() => vi.unstubAllEnvs());

function unreadRequest(url: string, method: string, contentType: string): Request {
  return new Request(url, {
    method,
    headers: { "content-type": contentType },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("PRIVATE_BODY_MUST_NOT_BE_READ"));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

test("private API routes reject unauthenticated requests before consuming their bodies", async () => {
  const cases: Array<[Request, (request: Request) => Promise<Response>]> = [
    [unreadRequest("https://assistant.test/api/imports", "POST", "multipart/form-data; boundary=x"), importRoom],
    [unreadRequest("https://assistant.test/api/replies", "POST", "application/json"), reply],
    [unreadRequest(`https://assistant.test/api/profiles/${participantId}`, "PATCH", "application/json"), (request) => editProfile(request, { params: Promise.resolve({ participantId }) })],
    [unreadRequest(`https://assistant.test/api/profiles/${participantId}/chat`, "POST", "application/json"), (request) => correctProfile(request, { params: Promise.resolve({ participantId }) })],
  ];

  for (const [request, handler] of cases) {
    expect(request.body?.locked).toBe(false);
    const response = await handler(request);
    expect(response.status).toBe(401);
    expect(request.body?.locked).toBe(false);
  }
});

test("login, profile edit, and correction bodies have hard byte caps", async () => {
  const loginResponse = await login(new Request("https://assistant.test/api/session", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(8 * 1024 + 1) },
    body: "{}",
  }));
  expect(loginResponse.status).toBe(413);

  const cookie = (await createSessionCookie(password)).split(";", 1)[0]!;
  const profileResponse = await editProfile(new Request(`https://assistant.test/api/profiles/${participantId}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json", "content-length": String(64 * 1024 + 1) },
    body: "{}",
  }), { params: Promise.resolve({ participantId }) });
  expect(profileResponse.status).toBe(413);

  const correctionResponse = await correctProfile(new Request(`https://assistant.test/api/profiles/${participantId}/chat`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "content-length": String(64 * 1024 + 1) },
    body: "{}",
  }), { params: Promise.resolve({ participantId }) });
  expect(correctionResponse.status).toBe(413);
});

test("offline browser storage encrypts every private payload and isolates participants by room", () => {
  const privateSubstring = "이번 주말 홍대에서 만나";
  const first = importFixtureRoom({
    title: "민수와 비밀 대화",
    selfName: "나",
    rawText: `비밀방 카카오톡 대화\n2026. 8. 7. 오후 1:01, 민수 : ${privateSubstring}`,
  });
  const second = importFixtureRoom({
    title: "다른 방",
    selfName: "나",
    rawText: "다른 방 카카오톡 대화\n2026. 8. 7. 오후 1:01, 서연 : 별도 메시지",
  });
  analyzeFixtureRoom(first.roomId);

  const firstParticipant = importParticipant(first.roomId);
  expect(fixtureParticipantBelongsToRoom(first.roomId, firstParticipant)).toBe(true);
  expect(fixtureParticipantBelongsToRoom(second.roomId, firstParticipant)).toBe(false);
  expect(fixtureStoredPayloads(first.roomId)).not.toHaveLength(0);
  expect(fixtureStoredPayloads(first.roomId).join("\n")).not.toMatch(/민수|비밀|홍대|이번 주말/u);

  deleteFixtureRoom(first.roomId);
  deleteFixtureRoom(second.roomId);
  expect(fixtureRoomCounts(first.roomId)).toEqual({
    rooms: 0,
    messages: 0,
    chunks: 0,
    profileFacts: 0,
    replyRequests: 0,
    replyCandidates: 0,
  });
});

function importParticipant(roomId: string): string {
  const participant = getFixtureRoom(roomId)?.participants.find((entry) => !entry.isSelf);
  if (!participant) throw new Error("fixture participant missing");
  return participant.id;
}
