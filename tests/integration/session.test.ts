import { hash } from "@node-rs/argon2";

import {
  InvalidPasswordError,
  createSessionCookie,
  requireSession,
} from "@/domain/auth/session";
import { POST } from "@/app/api/session/route";

const databaseUrl = "postgresql://postgres:postgres@localhost:5432/private_reply_assistant";
const password = "local-test-password";
const sessionSigningKey = Buffer.alloc(32, 13).toString("base64");
let passwordHash: string;

function cookieHeader(setCookie: string): string {
  return setCookie.split(";", 1)[0];
}

beforeAll(async () => {
  passwordHash = await hash(password);
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-07T00:00:00.000Z"));
  vi.stubEnv("DATABASE_URL", databaseUrl);
  vi.stubEnv("APP_PASSWORD_HASH", passwordHash);
  vi.stubEnv("SESSION_SIGNING_KEY", sessionSigningKey);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

test("creates a hardened 12-hour cookie for a valid password", async () => {
  const cookie = await createSessionCookie(password);

  expect(cookie).toContain("private_reply_session=");
  expect(cookie).toContain("Max-Age=43200");
  expect(cookie).toContain("Secure");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Strict");
  expect(cookie).toContain("Path=/");
});

test("rejects an invalid password without issuing a session", async () => {
  await expect(createSessionCookie("incorrect-password")).rejects.toBeInstanceOf(
    InvalidPasswordError,
  );
});

test("rejects a signing key shorter than 32 decoded bytes", async () => {
  vi.stubEnv("SESSION_SIGNING_KEY", Buffer.alloc(31, 13).toString("base64"));

  await expect(createSessionCookie(password)).rejects.toThrow(
    "SESSION_SIGNING_KEY must be canonical base64 encoding exactly 32 bytes",
  );
});

test("accepts a valid signed session and rejects tampering from API requests", async () => {
  const cookie = cookieHeader(await createSessionCookie(password));
  const authenticatedRequest = new Request("https://assistant.test/api/rooms", {
    headers: { cookie },
  });

  await expect(requireSession(authenticatedRequest)).resolves.toBeUndefined();

  const tampered = `${cookie.slice(0, -1)}${cookie.endsWith("A") ? "B" : "A"}`;
  const tamperedRequest = new Request("https://assistant.test/api/rooms", {
    headers: { cookie: tampered },
  });
  const rejection = await requireSession(tamperedRequest).catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(Response);
  expect((rejection as Response).status).toBe(401);
});

test("rejects an expired session", async () => {
  const cookie = cookieHeader(await createSessionCookie(password));
  vi.advanceTimersByTime(12 * 60 * 60 * 1000 + 1000);
  const request = new Request("https://assistant.test/api/rooms", {
    headers: { cookie },
  });
  const rejection = await requireSession(request).catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(Response);
  expect((rejection as Response).status).toBe(401);
});

test("redirects unauthenticated browser requests to login", async () => {
  const request = new Request("https://assistant.test/rooms");
  const rejection = await requireSession(request).catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(Response);
  expect((rejection as Response).status).toBe(307);
  expect((rejection as Response).headers.get("location")).toBe(
    "https://assistant.test/login",
  );
});

test("session route returns 401 for an invalid password", async () => {
  const request = new Request("https://assistant.test/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "incorrect-password" }),
  });

  const response = await POST(request);

  expect(response.status).toBe(401);
  expect(response.headers.get("set-cookie")).toBeNull();
});

test("session route issues the hardened cookie and redirects after login", async () => {
  const request = new Request("https://assistant.test/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });

  const response = await POST(request);

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("https://assistant.test/");
  expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
});
