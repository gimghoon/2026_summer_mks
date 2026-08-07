import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { getEnv } from "@/lib/env";
import * as schema from "./schema";

let database: NodePgDatabase<typeof schema> | undefined;

export function getDb(): NodePgDatabase<typeof schema> {
  if (!database) {
    const pool = new Pool({ connectionString: getEnv().DATABASE_URL });
    database = drizzle({ client: pool, schema });
  }

  return database;
}
