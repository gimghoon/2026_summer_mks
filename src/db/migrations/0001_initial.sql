CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE TYPE relationship_style AS ENUM ('female_friend', 'girlfriend');
--> statement-breakpoint
CREATE TYPE profile_fact_source AS ENUM ('ai_inference', 'user_confirmed', 'user_edited', 'ai_change_proposal');
--> statement-breakpoint
CREATE TYPE reply_strategy AS ENUM ('relationship_soft', 'emotion_signal', 'clearer_request');
--> statement-breakpoint
CREATE TABLE rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  encrypted_title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  encrypted_name text NOT NULL,
  is_self boolean NOT NULL DEFAULT false,
  relationship_style relationship_style,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL,
  kind text NOT NULL,
  encrypted_text text NOT NULL,
  source_fingerprint text NOT NULL,
  source_line integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_room_source_fingerprint_unique UNIQUE (room_id, source_fingerprint)
);
--> statement-breakpoint
CREATE TABLE turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  encrypted_message_ids text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  start_turn_id uuid NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  end_turn_id uuid NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  encrypted_summary text NOT NULL,
  encrypted_topic_tags text NOT NULL,
  encrypted_event_types text NOT NULL,
  embedding vector(1536) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX chunks_embedding_hnsw_cosine_index ON chunks USING hnsw (embedding vector_cosine_ops);
--> statement-breakpoint
CREATE TABLE room_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL UNIQUE REFERENCES rooms(id) ON DELETE CASCADE,
  encrypted_summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE profile_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  kind text NOT NULL,
  encrypted_value text NOT NULL,
  encrypted_conditions text NOT NULL,
  encrypted_exceptions text NOT NULL,
  evidence_turn_ids text NOT NULL,
  confidence real NOT NULL,
  source profile_fact_source NOT NULL,
  locked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE profile_fact_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_fact_id uuid NOT NULL REFERENCES profile_facts(id) ON DELETE CASCADE,
  encrypted_previous_value text,
  encrypted_next_value text NOT NULL,
  encrypted_conditions text NOT NULL,
  encrypted_exceptions text NOT NULL,
  source profile_fact_source NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE reply_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  relationship_style relationship_style NOT NULL,
  indirectness integer NOT NULL,
  encrypted_pasted_conversation text NOT NULL,
  encrypted_situation text NOT NULL,
  encrypted_intent text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reply_requests_indirectness_check CHECK (indirectness BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE reply_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reply_request_id uuid NOT NULL REFERENCES reply_requests(id) ON DELETE CASCADE,
  strategy reply_strategy NOT NULL,
  encrypted_text text NOT NULL,
  encrypted_intent_label text NOT NULL,
  encrypted_risk_label text,
  selected boolean NOT NULL DEFAULT false,
  encrypted_edited_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
