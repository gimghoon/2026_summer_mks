import { hash } from "@node-rs/argon2";

const importKakaoExportMock = vi.hoisted(() => vi.fn());

vi.mock("@/domain/imports/import-service", () => ({
  importKakaoExport: importKakaoExportMock,
}));

import { POST } from "@/app/api/imports/route";
import { createSessionCookie } from "@/domain/auth/session";
import { MAX_IMPORT_FILE_BYTES } from "@/domain/imports/import-limits";

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

async function authenticatedRequest(formData: FormData): Promise<Request> {
  const cookie = (await createSessionCookie(password)).split(";", 1)[0]!;
  return new Request("https://assistant.test/api/imports", {
    method: "POST",
    headers: { cookie },
    body: formData,
  });
}

test("returns Zod validation errors for a missing selfName", async () => {
  const formData = new FormData();
  formData.set("file", new File(["대화방 카카오톡 대화"], "chat.txt", { type: "text/plain" }));

  const response = await POST(await authenticatedRequest(formData));

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({ error: "Invalid import request" });
});

test("refuses a file larger than 50 MiB before reading it", async () => {
  const formData = new FormData();
  formData.set("selfName", "지훈");
  formData.set("file", new File([new Uint8Array(MAX_IMPORT_FILE_BYTES + 1)], "chat.txt"));

  const request = await authenticatedRequest(formData);
  // Undici's multipart parser rejects this large synthetic body before the
  // handler runs. Override only that transport boundary to exercise the
  // route's explicit 50 MiB guard.
  Object.defineProperty(request, "formData", { value: async () => formData });
  const response = await POST(request);

  expect(response.status).toBe(413);
  expect(importKakaoExportMock).not.toHaveBeenCalled();
});
