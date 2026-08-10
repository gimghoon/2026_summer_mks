import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { getEnv } from "@/lib/env";
import * as schema from "./schema";

let database: NodePgDatabase<typeof schema> | undefined;
let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: getEnv().DATABASE_URL });
  return pool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!database) {
    database = drizzle({ client: getPool(), schema });
  }

  return database;
}

/** Gives a job one physical PostgreSQL session, required by session advisory locks. */
export async function withDedicatedDatabase<T>(
  work: (database: NodePgDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    return await work(drizzle({ client, schema }));
  } finally {
    client.release();
  }
}
