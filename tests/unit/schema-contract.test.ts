import { existsSync, readFileSync } from "node:fs";

import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  chunks,
  messages,
  participants,
  profileFactRevisions,
  profileFacts,
  replyCandidates,
  replyRequests,
  roomAnalysisRuns,
  roomMemories,
  rooms,
  turns,
} from "@/db/schema";

const tables = [
  rooms,
  participants,
  messages,
  turns,
  chunks,
  roomMemories,
  profileFacts,
  profileFactRevisions,
  replyRequests,
  replyCandidates,
];

test("defines every conversation and reply table with UUID primary keys", () => {
  expect(tables.map(getTableName)).toEqual([
    "rooms",
    "participants",
    "messages",
    "turns",
    "chunks",
    "room_memories",
    "profile_facts",
    "profile_fact_revisions",
    "reply_requests",
    "reply_candidates",
  ]);

  for (const table of tables) {
    const { id } = getTableColumns(table);
    expect(id.columnType).toBe("PgUUID");
    expect(id.primary).toBe(true);
  }
});

test("uses cascading foreign keys for room-owned and derived data", () => {
  for (const table of tables.slice(1)) {
    const foreignKeys = getTableConfig(table).foreignKeys;
    expect(foreignKeys.length).toBeGreaterThan(0);
    expect(foreignKeys.every((foreignKey) => foreignKey.onDelete === "cascade")).toBe(true);
  }
});

test("profile facts retain provenance and lock state", () => {
  expect(Object.keys(getTableColumns(profileFacts))).toEqual(expect.arrayContaining([
    "participantId", "kind", "encryptedValue", "confidence", "source", "locked",
  ]));
});

test("reply candidates preserve strategy and selection feedback", () => {
  expect(Object.keys(getTableColumns(replyCandidates))).toEqual(expect.arrayContaining([
    "replyRequestId", "strategy", "encryptedText", "encryptedContextBasis", "encryptedWarnings", "selected", "encryptedEditedText",
  ]));
});

test("registers nullable encrypted reply evidence and warnings", () => {
  const migration = readFileSync("src/db/migrations/0004_advisory_reply_metadata.sql", "utf8");
  const journal = JSON.parse(readFileSync("src/db/migrations/meta/_journal.json", "utf8")) as {
    entries: Array<{ tag: string }>;
  };

  expect(migration).toMatch(/ADD COLUMN "encrypted_context_basis" text/iu);
  expect(migration).toMatch(/ADD COLUMN "encrypted_warnings" text/iu);
  expect(journal.entries).toContainEqual(expect.objectContaining({ tag: "0004_advisory_reply_metadata" }));
});

test("stores the required personal context request mode", () => {
  expect(Object.keys(getTableColumns(replyRequests))).toContain("personalContextMode");
  const migration = readFileSync(
    "src/db/migrations/0005_required_personal_context_mode.sql",
    "utf8",
  );
  expect(migration).toMatch(/ADD COLUMN "personal_context_mode" text DEFAULT 'normal' NOT NULL/iu);
  expect(migration).toMatch(/CHECK \("reply_requests"\."personal_context_mode" in \('normal', 'required'\)\)/iu);
});

test("preserves idempotent imports and vector search configuration", () => {
  const messageConfig = getTableConfig(messages);
  expect(messageConfig.uniqueConstraints).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "messages_room_source_fingerprint_unique" }),
  ]));

  const chunkConfig = getTableConfig(chunks);
  expect(getTableColumns(chunks).embedding.getSQLType()).toBe("vector(1536)");
  expect(chunkConfig.indexes).toEqual(expect.arrayContaining([
    expect.objectContaining({ config: expect.objectContaining({ method: "hnsw" }) }),
  ]));
});

test("tracks one cascading analysis run per room", () => {
  expect(getTableName(roomAnalysisRuns)).toBe("room_analysis_runs");
  const columns = getTableColumns(roomAnalysisRuns);
  expect(columns.roomId.primary).toBe(true);
  expect(Object.keys(columns)).toEqual(expect.arrayContaining([
    "status", "stage", "completedChunks", "totalChunks", "failure", "updatedAt",
  ]));
  expect(getTableConfig(roomAnalysisRuns).foreignKeys).toEqual([
    expect.objectContaining({ onDelete: "cascade" }),
  ]);
});

test("registers a vector-enabled initial migration for all tables", () => {
  const migration = readFileSync("src/db/migrations/0001_initial.sql", "utf8");
  const journal = JSON.parse(readFileSync("src/db/migrations/meta/_journal.json", "utf8")) as {
    entries: Array<{ tag: string }>;
  };

  expect(migration).toMatch(/CREATE EXTENSION IF NOT EXISTS vector/i);
  expect(migration).toMatch(/USING hnsw \(embedding vector_cosine_ops\)/i);
  expect(migration).toMatch(/UNIQUE \(room_id, source_fingerprint\)/i);
  for (const table of tables) {
    expect(migration).toMatch(new RegExp(`CREATE TABLE ${getTableName(table)} \\(`, "i"));
  }
  expect(journal.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ tag: "0001_initial" }),
  ]));
});

test("registers the constrained room analysis progress migration", () => {
  const migration = readFileSync("src/db/migrations/0002_room_analysis_runs.sql", "utf8");
  const journal = JSON.parse(readFileSync("src/db/migrations/meta/_journal.json", "utf8")) as {
    entries: Array<{ tag: string }>;
  };

  expect(migration).toMatch(/CREATE TABLE\s+"?room_analysis_runs"?/i);
  expect(migration).toMatch(/REFERENCES\s+"?(?:public"?\.)?"?rooms"?\("?id"?\)\s+ON DELETE cascade/i);
  expect(migration).toMatch(/"?completed_chunks"? >= 0/i);
  expect(migration).toMatch(/"?completed_chunks"? <= (?:"room_analysis_runs"\.)?"?total_chunks"?/i);
  expect(journal.entries).toContainEqual(expect.objectContaining({ tag: "0002_room_analysis_runs" }));
});

test("expands the stored reply indirectness constraint through level seven", () => {
  const schema = readFileSync("src/db/schema.ts", "utf8");
  const migrationPath = "src/db/migrations/0003_expand_indirectness.sql";

  expect(schema).toMatch(/reply_requests_indirectness_check[\s\S]*between 1 and 7/iu);
  expect(existsSync(migrationPath)).toBe(true);
  if (!existsSync(migrationPath)) return;

  const migration = readFileSync(migrationPath, "utf8");
  const journal = JSON.parse(readFileSync("src/db/migrations/meta/_journal.json", "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  expect(migration).toMatch(/DROP CONSTRAINT "reply_requests_indirectness_check"/iu);
  expect(migration).toMatch(/ADD CONSTRAINT "reply_requests_indirectness_check" CHECK \("reply_requests"\."indirectness" between 1 and 7\)/iu);
  expect(journal.entries).toContainEqual(expect.objectContaining({ tag: "0003_expand_indirectness" }));
});
