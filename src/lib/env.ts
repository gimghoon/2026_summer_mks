import { z } from "zod";

const SESSION_SIGNING_KEY_ERROR =
  "SESSION_SIGNING_KEY must be canonical base64 encoding exactly 32 bytes";

function isCanonicalBase64Key(value: string): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }

  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 && decoded.toString("base64") === value;
}

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  APP_ENCRYPTION_KEY: z.string().optional(),
  APP_PASSWORD_HASH: z.string().optional(),
  SESSION_SIGNING_KEY: z.string().refine(isCanonicalBase64Key, {
    message: SESSION_SIGNING_KEY_ERROR,
  }).optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANALYSIS_MODEL: z.string().optional(),
  REPLY_MODEL: z.string().optional(),
  EMBEDDING_MODEL: z.string().optional(),
});

export type AppEnv = z.infer<typeof envSchema>;

export function getEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(source);
}
