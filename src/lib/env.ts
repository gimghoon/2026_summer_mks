import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  APP_ENCRYPTION_KEY: z.string().optional(),
  APP_PASSWORD_HASH: z.string().optional(),
  SESSION_SIGNING_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANALYSIS_MODEL: z.string().optional(),
  REPLY_MODEL: z.string().optional(),
  EMBEDDING_MODEL: z.string().optional(),
});

export type AppEnv = z.infer<typeof envSchema>;

export function getEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(source);
}
