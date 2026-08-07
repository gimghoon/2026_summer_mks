import { decryptJson, encryptJson } from "@/domain/crypto/encrypted-json";

const databaseUrl = "postgresql://postgres:postgres@localhost:5432/private_reply_assistant";

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", databaseUrl);
  vi.stubEnv("APP_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test("round-trips Korean conversation data without plaintext leakage", () => {
  const source = { speaker: "민수", text: "오늘 조금 늦을 것 같아" };
  const encrypted = encryptJson(source);

  expect(encrypted).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  expect(encrypted).not.toContain("민수");
  expect(encrypted).not.toContain("늦을");
  expect(decryptJson<typeof source>(encrypted)).toEqual(source);
});

test("uses a fresh IV for every encrypted payload", () => {
  const source = { text: "같은 입력" };

  expect(encryptJson(source)).not.toBe(encryptJson(source));
});

test("rejects modified ciphertext", () => {
  const parts = encryptJson({ text: "비밀" }).split(".");
  const ciphertext = Buffer.from(parts[2], "base64url");
  ciphertext[0] ^= 1;
  parts[2] = ciphertext.toString("base64url");

  expect(() => decryptJson(parts.join("."))).toThrow(
    "Encrypted payload authentication failed",
  );
});

test("rejects the binding final-character tamper case", () => {
  const encrypted = encryptJson({ text: "비밀" });

  expect(() => decryptJson(`${encrypted.slice(0, -1)}A`)).toThrow(
    "Encrypted payload authentication failed",
  );
});

test("requires an encryption key that decodes to exactly 32 bytes", () => {
  vi.stubEnv("APP_ENCRYPTION_KEY", Buffer.alloc(31).toString("base64"));

  expect(() => encryptJson({ ok: true })).toThrow(
    "APP_ENCRYPTION_KEY must decode to exactly 32 bytes",
  );
});

test("rejects non-base64 characters in the encryption key", () => {
  vi.stubEnv("APP_ENCRYPTION_KEY", `${Buffer.alloc(32).toString("base64")}!`);

  expect(() => encryptJson({ ok: true })).toThrow(
    "APP_ENCRYPTION_KEY must decode to exactly 32 bytes",
  );
});
