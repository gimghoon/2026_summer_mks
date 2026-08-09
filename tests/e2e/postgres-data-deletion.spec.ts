import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { Pool, type PoolClient } from "pg";

import { encryptJson } from "@/domain/crypto/encrypted-json";
import { login } from "./helpers";
import { requireSafePostgresTestUrl } from "./postgres-safety.mjs";

const databaseUrl = requireSafePostgresTestUrl(process.env.E2E_DATABASE_URL);
const encryptionKey = Buffer.alloc(32, 7).toString("base64");
process.env.DATABASE_URL = databaseUrl;
process.env.APP_ENCRYPTION_KEY = encryptionKey;

type SeedIds = {
  roomId: string;
  unrelatedRoomId: string;
};

type CascadeCounts = {
  rooms: number;
  participants: number;
  messages: number;
  turns: number;
  chunks: number;
  roomMemories: number;
  profileFacts: number;
  profileFactRevisions: number;
  replyRequests: number;
  replyCandidates: number;
};

const zeroCounts: CascadeCounts = {
  rooms: 0,
  participants: 0,
  messages: 0,
  turns: 0,
  chunks: 0,
  roomMemories: 0,
  profileFacts: 0,
  profileFactRevisions: 0,
  replyRequests: 0,
  replyCandidates: 0,
};

async function seedPrivateWorkflow(client: PoolClient): Promise<SeedIds> {
  const roomId = randomUUID();
  const unrelatedRoomId = randomUUID();
  const selfId = randomUUID();
  const participantId = randomUUID();
  const unrelatedParticipantId = randomUUID();
  const messageId = randomUUID();
  const turnId = randomUUID();
  const chunkId = randomUUID();
  const memoryId = randomUUID();
  const factId = randomUUID();
  const revisionId = randomUUID();
  const replyRequestId = randomUUID();
  const replyCandidateId = randomUUID();
  const vector = `[${Array.from({ length: 1536 }, () => "0").join(",")}]`;

  await client.query("BEGIN");
  try {
    await client.query(
      "INSERT INTO rooms (id, encrypted_title) VALUES ($1, $2), ($3, $4)",
      [
        roomId,
        encryptJson("PostgreSQL 삭제 검증방"),
        unrelatedRoomId,
        encryptJson("삭제되면 안 되는 별도 방"),
      ],
    );
    await client.query(
      `INSERT INTO participants
        (id, room_id, encrypted_name, is_self, relationship_style)
       VALUES
        ($1, $2, $3, true, NULL),
        ($4, $2, $5, false, 'female_friend'),
        ($6, $7, $8, false, 'female_friend')`,
      [
        selfId,
        roomId,
        encryptJson("나"),
        participantId,
        encryptJson("민수"),
        unrelatedParticipantId,
        unrelatedRoomId,
        encryptJson("서연"),
      ],
    );
    await client.query(
      `INSERT INTO messages
        (id, room_id, participant_id, sent_at, kind, encrypted_text, source_fingerprint, source_line)
       VALUES ($1, $2, $3, now(), 'text', $4, $5, 1)`,
      [messageId, roomId, participantId, encryptJson("삭제되어야 할 비밀 메시지"), `e2e-${messageId}`],
    );
    await client.query(
      `INSERT INTO turns
        (id, room_id, participant_id, started_at, ended_at, encrypted_message_ids)
       VALUES ($1, $2, $3, now(), now(), $4)`,
      [turnId, roomId, participantId, encryptJson([messageId])],
    );
    await client.query(
      `INSERT INTO chunks
        (id, room_id, start_turn_id, end_turn_id, started_at, ended_at,
         encrypted_summary, encrypted_topic_tags, encrypted_event_types, embedding)
       VALUES ($1, $2, $3, $3, now(), now(), $4, $5, $6, $7::vector)`,
      [
        chunkId,
        roomId,
        turnId,
        encryptJson({ analysisComplete: true, summary: "삭제 대상 요약" }),
        encryptJson(["약속"]),
        encryptJson(["daily_chat"]),
        vector,
      ],
    );
    await client.query(
      "INSERT INTO room_memories (id, room_id, encrypted_summary) VALUES ($1, $2, $3)",
      [memoryId, roomId, encryptJson({ version: 1, summary: "삭제 대상 장기 기억" })],
    );
    await client.query(
      `INSERT INTO profile_facts
        (id, participant_id, kind, encrypted_value, encrypted_conditions,
         encrypted_exceptions, evidence_turn_ids, confidence, source, locked)
       VALUES ($1, $2, 'personality_tendency', $3, $4, $5, $6, 1, 'user_edited', true)`,
      [
        factId,
        participantId,
        encryptJson("삭제 대상 프로필"),
        encryptJson([]),
        encryptJson([]),
        encryptJson([turnId]),
      ],
    );
    await client.query(
      `INSERT INTO profile_fact_revisions
        (id, profile_fact_id, encrypted_previous_value, encrypted_next_value,
         encrypted_conditions, encrypted_exceptions, source)
       VALUES ($1, $2, $3, $4, $5, $6, 'user_edited')`,
      [
        revisionId,
        factId,
        encryptJson("이전 프로필"),
        encryptJson("삭제 대상 프로필"),
        encryptJson([]),
        encryptJson([]),
      ],
    );
    await client.query(
      `INSERT INTO reply_requests
        (id, room_id, participant_id, relationship_style, indirectness,
         encrypted_pasted_conversation, encrypted_situation, encrypted_intent)
       VALUES ($1, $2, $3, 'female_friend', 3, $4, $5, $6)`,
      [
        replyRequestId,
        roomId,
        participantId,
        encryptJson("삭제 대상 최근 대화"),
        encryptJson("삭제 대상 현재 상황"),
        encryptJson("관계 유지"),
      ],
    );
    await client.query(
      `INSERT INTO reply_candidates
        (id, reply_request_id, strategy, encrypted_text, encrypted_intent_label, encrypted_risk_label)
       VALUES ($1, $2, 'relationship_soft', $3, $4, $5)`,
      [
        replyCandidateId,
        replyRequestId,
        encryptJson("삭제 대상 답장"),
        encryptJson("부드럽게 전달"),
        encryptJson("낮은 위험"),
      ],
    );
    await client.query("COMMIT");
    return { roomId, unrelatedRoomId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function cascadeCounts(client: PoolClient, roomId: string): Promise<CascadeCounts> {
  const result = await client.query<CascadeCounts>(
    `SELECT
      (SELECT count(*)::int FROM rooms WHERE id = $1) AS rooms,
      (SELECT count(*)::int FROM participants WHERE room_id = $1) AS participants,
      (SELECT count(*)::int FROM messages WHERE room_id = $1) AS messages,
      (SELECT count(*)::int FROM turns WHERE room_id = $1) AS turns,
      (SELECT count(*)::int FROM chunks WHERE room_id = $1) AS chunks,
      (SELECT count(*)::int FROM room_memories WHERE room_id = $1) AS "roomMemories",
      (SELECT count(*)::int FROM profile_facts f
        JOIN participants p ON p.id = f.participant_id WHERE p.room_id = $1) AS "profileFacts",
      (SELECT count(*)::int FROM profile_fact_revisions r
        JOIN profile_facts f ON f.id = r.profile_fact_id
        JOIN participants p ON p.id = f.participant_id WHERE p.room_id = $1) AS "profileFactRevisions",
      (SELECT count(*)::int FROM reply_requests WHERE room_id = $1) AS "replyRequests",
      (SELECT count(*)::int FROM reply_candidates c
        JOIN reply_requests r ON r.id = c.reply_request_id WHERE r.room_id = $1) AS "replyCandidates"`,
    [roomId],
  );
  const counts = result.rows[0];
  if (!counts) throw new Error("PostgreSQL cascade count query returned no row");
  return counts;
}

test("production deletion route removes real PostgreSQL cascades and preserves another room", async ({ page }) => {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  let ids: SeedIds | null = null;
  try {
    ids = await seedPrivateWorkflow(client);
    expect(await cascadeCounts(client, ids.roomId)).toEqual({
      rooms: 1,
      participants: 2,
      messages: 1,
      turns: 1,
      chunks: 1,
      roomMemories: 1,
      profileFacts: 1,
      profileFactRevisions: 1,
      replyRequests: 1,
      replyCandidates: 1,
    });

    await login(page);
    const health = await page.evaluate(async (roomId) => (
      fetch(`/api/health?roomId=${roomId}`).then((response) => response.json())
    ), ids.roomId);
    expect(health).toEqual({ status: "ok" });

    await page.goto(`/rooms/${ids.roomId}`);
    await expect(page.getByRole("heading", { name: "PostgreSQL 삭제 검증방" })).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "대화방 삭제" }).click();
    await expect(page).toHaveURL(/\/rooms$/u);
    expect((await page.goto(`/rooms/${ids.roomId}`))?.status()).toBe(404);

    expect(await cascadeCounts(client, ids.roomId)).toEqual(zeroCounts);
    const unrelated = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM rooms WHERE id = $1",
      [ids.unrelatedRoomId],
    );
    expect(unrelated.rows[0]?.count).toBe(1);
  } finally {
    if (ids) {
      await client.query("DELETE FROM rooms WHERE id = ANY($1::uuid[])", [
        [ids.roomId, ids.unrelatedRoomId],
      ]);
    }
    client.release();
    await pool.end();
  }
});
