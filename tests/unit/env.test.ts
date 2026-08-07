import { getEnv } from "@/lib/env";

const databaseUrl = "postgresql://postgres:postgres@localhost:5432/private_reply_assistant";

test("accepts a canonical base64 session key that decodes to 32 bytes", () => {
  const sessionSigningKey = Buffer.alloc(32, 11).toString("base64");

  expect(getEnv({
    DATABASE_URL: databaseUrl,
    NODE_ENV: "test",
    SESSION_SIGNING_KEY: sessionSigningKey,
  }).SESSION_SIGNING_KEY).toBe(sessionSigningKey);
});

test("rejects a session key shorter than 32 decoded bytes", () => {
  expect(() => getEnv({
    DATABASE_URL: databaseUrl,
    NODE_ENV: "test",
    SESSION_SIGNING_KEY: Buffer.alloc(31, 11).toString("base64"),
  })).toThrow("SESSION_SIGNING_KEY must be canonical base64 encoding exactly 32 bytes");
});

test.each([
  ["invalid characters", "not-base64!"],
  ["missing padding", Buffer.alloc(32, 11).toString("base64").replace(/=$/, "")],
])("rejects a session key with %s", (_caseName, sessionSigningKey) => {
  expect(() => getEnv({
    DATABASE_URL: databaseUrl,
    NODE_ENV: "test",
    SESSION_SIGNING_KEY: sessionSigningKey,
  })).toThrow("SESSION_SIGNING_KEY must be canonical base64 encoding exactly 32 bytes");
});
