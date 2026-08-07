import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

export type RelationshipStyle = "female_friend" | "girlfriend";
export type ProfileFactSource = "ai_inference" | "user_confirmed" | "user_edited" | "ai_change_proposal";
export type ReplyStrategy = "relationship_soft" | "emotion_signal" | "clearer_request";

export const relationshipStyleEnum = pgEnum("relationship_style", ["female_friend", "girlfriend"]);
export const profileFactSourceEnum = pgEnum("profile_fact_source", [
  "ai_inference",
  "user_confirmed",
  "user_edited",
  "ai_change_proposal",
]);
export const replyStrategyEnum = pgEnum("reply_strategy", [
  "relationship_soft",
  "emotion_signal",
  "clearer_request",
]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const rooms = pgTable("rooms", {
  id: uuid("id").defaultRandom().primaryKey(),
  encryptedTitle: text("encrypted_title").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const participants = pgTable(
  "participants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
    encryptedName: text("encrypted_name").notNull(),
    isSelf: boolean("is_self").notNull().default(false),
    relationshipStyle: relationshipStyleEnum("relationship_style"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id").notNull().references(() => participants.id, { onDelete: "cascade" }),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    kind: text("kind").notNull(),
    encryptedText: text("encrypted_text").notNull(),
    sourceFingerprint: text("source_fingerprint").notNull(),
    sourceLine: integer("source_line").notNull(),
    createdAt: createdAt(),
  },
  (table) => [unique("messages_room_source_fingerprint_unique").on(table.roomId, table.sourceFingerprint)],
);

export const turns = pgTable("turns", {
  id: uuid("id").defaultRandom().primaryKey(),
  roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
  participantId: uuid("participant_id").notNull().references(() => participants.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
  encryptedMessageIds: text("encrypted_message_ids").notNull(),
  createdAt: createdAt(),
});

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
    startTurnId: uuid("start_turn_id").notNull().references(() => turns.id, { onDelete: "cascade" }),
    endTurnId: uuid("end_turn_id").notNull().references(() => turns.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
    encryptedSummary: text("encrypted_summary").notNull(),
    encryptedTopicTags: text("encrypted_topic_tags").notNull(),
    encryptedEventTypes: text("encrypted_event_types").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("chunks_embedding_hnsw_cosine_index").using("hnsw", table.embedding.op("vector_cosine_ops"))],
);

export const roomMemories = pgTable("room_memories", {
  id: uuid("id").defaultRandom().primaryKey(),
  roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }).unique(),
  encryptedSummary: text("encrypted_summary").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const profileFacts = pgTable("profile_facts", {
  id: uuid("id").defaultRandom().primaryKey(),
  participantId: uuid("participant_id").notNull().references(() => participants.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  encryptedValue: text("encrypted_value").notNull(),
  encryptedConditions: text("encrypted_conditions").notNull(),
  encryptedExceptions: text("encrypted_exceptions").notNull(),
  evidenceTurnIds: text("evidence_turn_ids").notNull(),
  confidence: real("confidence").notNull(),
  source: profileFactSourceEnum("source").notNull(),
  locked: boolean("locked").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const profileFactRevisions = pgTable("profile_fact_revisions", {
  id: uuid("id").defaultRandom().primaryKey(),
  profileFactId: uuid("profile_fact_id").notNull().references(() => profileFacts.id, { onDelete: "cascade" }),
  encryptedPreviousValue: text("encrypted_previous_value"),
  encryptedNextValue: text("encrypted_next_value").notNull(),
  encryptedConditions: text("encrypted_conditions").notNull(),
  encryptedExceptions: text("encrypted_exceptions").notNull(),
  source: profileFactSourceEnum("source").notNull(),
  createdAt: createdAt(),
});

export const replyRequests = pgTable(
  "reply_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id").notNull().references(() => participants.id, { onDelete: "cascade" }),
    relationshipStyle: relationshipStyleEnum("relationship_style").notNull(),
    indirectness: integer("indirectness").notNull(),
    encryptedPastedConversation: text("encrypted_pasted_conversation").notNull(),
    encryptedSituation: text("encrypted_situation").notNull(),
    encryptedIntent: text("encrypted_intent").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check("reply_requests_indirectness_check", sql`${table.indirectness} between 1 and 5`),
  ],
);

export const replyCandidates = pgTable("reply_candidates", {
  id: uuid("id").defaultRandom().primaryKey(),
  replyRequestId: uuid("reply_request_id").notNull().references(() => replyRequests.id, { onDelete: "cascade" }),
  strategy: replyStrategyEnum("strategy").notNull(),
  encryptedText: text("encrypted_text").notNull(),
  encryptedIntentLabel: text("encrypted_intent_label").notNull(),
  encryptedRiskLabel: text("encrypted_risk_label"),
  selected: boolean("selected").notNull().default(false),
  encryptedEditedText: text("encrypted_edited_text"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
