import { readFileSync } from "node:fs";

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
    "replyRequestId", "strategy", "encryptedText", "selected", "encryptedEditedText",
  ]));
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
