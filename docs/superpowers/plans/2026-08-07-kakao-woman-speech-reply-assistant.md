# Kakao Woman-Speech Reply Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a private, mobile-responsive web app that imports KakaoTalk text exports, creates editable room and participant memories, retrieves relevant context, and recommends three Korean 20s woman-speech replies at a configurable indirectness level.

**Architecture:** Use a Next.js App Router application with server-only domain services and PostgreSQL persistence. Keep parsing, memory extraction, retrieval, style generation, encryption, and model access behind small typed interfaces; route handlers and server actions only validate input and orchestrate those services. Store encrypted message and profile payloads, while retaining non-sensitive identifiers and search vectors needed for retrieval.

**Tech Stack:** Node.js 22, TypeScript 5.9, Next.js 15, React 19, PostgreSQL 16 with pgvector, Drizzle ORM, Zod 4, OpenAI-compatible model adapter, Web Crypto/AES-256-GCM, Argon2id, Vitest, Testing Library, Playwright, pnpm.

## Global Constraints

- The MVP is a single-user, mobile-responsive web application.
- Support KakaoTalk `.txt` uploads and pasted current conversations.
- Start current-context analysis with 20 message turns, then expand to 40, 80, and the full current conversation chunk only when evidence is insufficient.
- Generate exactly three replies at one configured indirectness level from 1 through 5.
- Separate female-friend and girlfriend relationship styles; never add romantic cues to the female-friend style.
- User-confirmed and user-edited profile facts outrank AI inferences and cannot be overwritten automatically.
- Store raw conversations and profile contents encrypted; never write conversation text to application or error logs.
- Do not claim end-to-end encryption because the server and model provider process plaintext during analysis.
- Do not auto-send messages to KakaoTalk.
- Do not ingest private web screenshots or conversations without permission.
- Follow test-driven development: failing test, minimal implementation, passing test, then commit for every task.

## Planned File Structure

```text
src/
  app/
    (auth)/login/page.tsx
    api/imports/route.ts
    api/profiles/[participantId]/route.ts
    api/profiles/[participantId]/chat/route.ts
    api/replies/route.ts
    api/rooms/[roomId]/route.ts
    rooms/page.tsx
    rooms/[roomId]/page.tsx
    rooms/[roomId]/profiles/[participantId]/page.tsx
    rooms/[roomId]/reply/page.tsx
    layout.tsx
    page.tsx
  components/
    bottom-nav.tsx
    import-progress.tsx
    profile-card.tsx
    profile-editor.tsx
    profile-correction-chat.tsx
    reply-composer.tsx
    reply-results.tsx
    room-card.tsx
  db/
    client.ts
    schema.ts
    migrations/0001_initial.sql
  domain/
    auth/session.ts
    crypto/encrypted-json.ts
    imports/import-service.ts
    kakao/parser.ts
    kakao/turns.ts
    memory/chunker.ts
    memory/extractor.ts
    memory/profile-corrections.ts
    models/gateway.ts
    models/openai-gateway.ts
    profiles/profile-service.ts
    replies/context-expander.ts
    replies/reply-service.ts
    replies/style-policy.ts
    retrieval/context-repository.ts
    retrieval/vector-context-repository.ts
  lib/
    env.ts
    logger.ts
    result.ts
tests/
  e2e/private-reply-flow.spec.ts
  fixtures/kakao/group-chat.txt
  fixtures/kakao/one-to-one.txt
  integration/import-service.test.ts
  integration/profile-service.test.ts
  integration/reply-service.test.ts
  unit/chunker.test.ts
  unit/context-expander.test.ts
  unit/encrypted-json.test.ts
  unit/kakao-parser.test.ts
  unit/profile-corrections.test.ts
  unit/style-policy.test.ts
```

---

### Task 1: Application Shell and Test Harness

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `next.config.ts`
- Create: `vitest.config.ts`
- Create: `playwright.config.ts`
- Create: `src/app/layout.tsx`
- Create: `src/app/page.tsx`
- Create: `src/app/globals.css`
- Create: `tests/unit/app-shell.test.tsx`
- Create: `.env.example`

**Interfaces:**
- Consumes: none.
- Produces: `pnpm test`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm dev`, and the `@/*` TypeScript path alias used by every later task.

- [ ] **Step 1: Write the failing application-shell test**

```tsx
// tests/unit/app-shell.test.tsx
import { render, screen } from "@testing-library/react";
import HomePage from "@/app/page";

test("shows the private assistant entry point", () => {
  render(<HomePage />);
  expect(screen.getByRole("heading", { name: "내 카카오톡 답장 도우미" })).toBeVisible();
  expect(screen.getByRole("link", { name: "대화방 열기" })).toHaveAttribute("href", "/rooms");
});
```

- [ ] **Step 2: Create package configuration and run the test to verify failure**

Use exact package ranges in `package.json`:

```json
{
  "private": true,
  "packageManager": "pnpm@10.15.1",
  "engines": { "node": ">=22.0.0" },
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "lint": "next lint",
    "test": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "@node-rs/argon2": "^2.0.2",
    "drizzle-orm": "^0.44.5",
    "next": "^15.5.2",
    "openai": "^5.19.1",
    "pg": "^8.16.3",
    "react": "^19.1.1",
    "react-dom": "^19.1.1",
    "zod": "^4.1.5"
  },
  "devDependencies": {
    "@playwright/test": "^1.55.0",
    "@testing-library/jest-dom": "^6.8.0",
    "@testing-library/react": "^16.3.0",
    "@types/node": "^22.18.0",
    "@types/pg": "^8.15.5",
    "@types/react": "^19.1.12",
    "@types/react-dom": "^19.1.9",
    "drizzle-kit": "^0.31.4",
    "jsdom": "^26.1.0",
    "typescript": "^5.9.2",
    "vitest": "^3.2.4"
  }
}
```

Run: `pnpm install && pnpm test -- tests/unit/app-shell.test.tsx`

Expected: FAIL because `@/app/page` does not exist.

- [ ] **Step 3: Implement the minimal home page and shared layout**

```tsx
// src/app/page.tsx
import Link from "next/link";

export default function HomePage() {
  return (
    <main className="page-shell">
      <h1>내 카카오톡 답장 도우미</h1>
      <p>대화 맥락을 기억하고 여자어 답장 세 개를 추천합니다.</p>
      <Link href="/rooms">대화방 열기</Link>
    </main>
  );
}
```

Add `src/app/layout.tsx` with Korean metadata, `lang="ko"`, and `globals.css`. Configure Vitest with `jsdom`, the `@` alias, and `@testing-library/jest-dom/vitest` setup.

- [ ] **Step 4: Verify unit and production builds**

Run: `pnpm test -- tests/unit/app-shell.test.tsx && pnpm build`

Expected: one passing test and a successful Next.js production build.

- [ ] **Step 5: Commit the shell**

```bash
git add package.json pnpm-lock.yaml tsconfig.json next.config.ts vitest.config.ts playwright.config.ts .env.example src/app tests/unit/app-shell.test.tsx
git commit -m "chore: scaffold private reply assistant"
```

### Task 2: Typed Domain Model and PostgreSQL Schema

**Files:**
- Create: `src/db/schema.ts`
- Create: `src/db/client.ts`
- Create: `src/db/migrations/0001_initial.sql`
- Create: `src/lib/env.ts`
- Create: `tests/unit/schema-contract.test.ts`

**Interfaces:**
- Consumes: `@/*` alias from Task 1.
- Produces: `rooms`, `participants`, `messages`, `turns`, `chunks`, `roomMemories`, `profileFacts`, `profileFactRevisions`, `replyRequests`, and `replyCandidates` Drizzle tables; `getDb(): NodePgDatabase`.

- [ ] **Step 1: Write the failing schema contract test**

```ts
// tests/unit/schema-contract.test.ts
import { getTableColumns } from "drizzle-orm";
import { profileFacts, replyCandidates } from "@/db/schema";

test("profile facts retain provenance and lock state", () => {
  expect(Object.keys(getTableColumns(profileFacts))).toEqual(expect.arrayContaining([
    "participantId", "kind", "encryptedValue", "confidence", "source", "locked"
  ]));
});

test("reply candidates preserve strategy and selection feedback", () => {
  expect(Object.keys(getTableColumns(replyCandidates))).toEqual(expect.arrayContaining([
    "replyRequestId", "strategy", "encryptedText", "selected", "encryptedEditedText"
  ]));
});
```

- [ ] **Step 2: Run the schema test to verify failure**

Run: `pnpm vitest run tests/unit/schema-contract.test.ts`

Expected: FAIL because `@/db/schema` does not exist.

- [ ] **Step 3: Define schema and migration**

Use UUID primary keys, `timestamptz`, explicit foreign keys, and cascade deletion from rooms to derived data. Store sensitive payloads in `text` columns named `encrypted*`. Store embeddings in `vector(1536)` and create an HNSW cosine index on `chunks.embedding`.

Define these exact enums:

```ts
export type RelationshipStyle = "female_friend" | "girlfriend";
export type ProfileFactSource = "ai_inference" | "user_confirmed" | "user_edited" | "ai_change_proposal";
export type ReplyStrategy = "relationship_soft" | "emotion_signal" | "clearer_request";
```

The migration must enable `vector` and create all tables named by the `Produces` block. `messages` must have a unique `(room_id, source_fingerprint)` constraint for idempotent import.

- [ ] **Step 4: Verify schema test and migration syntax**

Run: `pnpm vitest run tests/unit/schema-contract.test.ts && pnpm drizzle-kit check`

Expected: both commands pass.

- [ ] **Step 5: Commit the data model**

```bash
git add src/db src/lib/env.ts tests/unit/schema-contract.test.ts
git commit -m "feat: define encrypted conversation data model"
```

### Task 3: Single-User Authentication, Encryption, and Safe Logging

**Files:**
- Create: `src/domain/crypto/encrypted-json.ts`
- Create: `src/domain/auth/session.ts`
- Create: `src/lib/logger.ts`
- Create: `src/app/(auth)/login/page.tsx`
- Create: `src/app/api/session/route.ts`
- Create: `tests/unit/encrypted-json.test.ts`
- Create: `tests/unit/logger.test.ts`
- Create: `tests/integration/session.test.ts`

**Interfaces:**
- Consumes: `APP_ENCRYPTION_KEY`, `APP_PASSWORD_HASH`, and `SESSION_SIGNING_KEY` validated by `src/lib/env.ts`.
- Produces: `encryptJson<T>(value: T): string`, `decryptJson<T>(payload: string): T`, `createSessionCookie(password: string): Promise<string>`, `requireSession(request?: Request): Promise<void>`, and `safeLog(event: string, metadata: Record<string, string | number | boolean>): void`.

- [ ] **Step 1: Write failing authenticated-encryption tests**

```ts
// tests/unit/encrypted-json.test.ts
import { decryptJson, encryptJson } from "@/domain/crypto/encrypted-json";

test("round-trips Korean conversation data without plaintext leakage", () => {
  const source = { speaker: "민수", text: "오늘 조금 늦을 것 같아" };
  const encrypted = encryptJson(source);
  expect(encrypted).not.toContain("민수");
  expect(encrypted).not.toContain("늦을");
  expect(decryptJson<typeof source>(encrypted)).toEqual(source);
});

test("rejects modified ciphertext", () => {
  const encrypted = encryptJson({ text: "비밀" });
  expect(() => decryptJson(`${encrypted.slice(0, -1)}A`)).toThrow("Encrypted payload authentication failed");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/unit/encrypted-json.test.ts tests/unit/logger.test.ts`

Expected: FAIL because encryption and logging modules do not exist.

- [ ] **Step 3: Implement encryption and redacted logging**

Encode payloads as `v1.<base64url(iv)>.<base64url(ciphertext)>.<base64url(tag)>`. Use AES-256-GCM with a fresh 12-byte IV per call. Parse `APP_ENCRYPTION_KEY` as exactly 32 base64-decoded bytes. Throw the exact authentication error from the test when GCM verification fails.

`safeLog` must only accept scalar metadata and reject keys matching `/text|message|content|name|profile|prompt/i` with `Unsafe log metadata key: <key>`.

- [ ] **Step 4: Implement password login and signed HttpOnly session**

Verify the submitted password with Argon2id against `APP_PASSWORD_HASH`. Issue a `Secure`, `HttpOnly`, `SameSite=Strict` cookie named `private_reply_session`, valid for 12 hours. `requireSession` verifies signature and expiry and redirects browser requests to `/login` or returns HTTP 401 from APIs.

- [ ] **Step 5: Verify security tests**

Run: `pnpm vitest run tests/unit/encrypted-json.test.ts tests/unit/logger.test.ts tests/integration/session.test.ts`

Expected: all encryption, tamper detection, redaction, login, expiry, and invalid-password tests pass.

- [ ] **Step 6: Commit authentication and encryption**

```bash
git add src/domain/crypto src/domain/auth src/lib/logger.ts 'src/app/(auth)' src/app/api/session tests/unit/encrypted-json.test.ts tests/unit/logger.test.ts tests/integration/session.test.ts
git commit -m "feat: protect private conversation data"
```

### Task 4: KakaoTalk Parsing, Turn Grouping, and Idempotent Import

**Files:**
- Create: `src/domain/kakao/parser.ts`
- Create: `src/domain/kakao/turns.ts`
- Create: `src/domain/imports/import-service.ts`
- Create: `src/app/api/imports/route.ts`
- Create: `tests/fixtures/kakao/one-to-one.txt`
- Create: `tests/fixtures/kakao/group-chat.txt`
- Create: `tests/unit/kakao-parser.test.ts`
- Create: `tests/integration/import-service.test.ts`

**Interfaces:**
- Consumes: `encryptJson`, database tables from Task 2, and `requireSession`.
- Produces: `parseKakaoExport(input: string): ParseResult`, `groupMessageTurns(messages: ParsedMessage[]): ParsedTurn[]`, and `importKakaoExport(command: ImportCommand): Promise<ImportSummary>`.

Define exact contracts:

```ts
export type ParsedMessage = {
  sentAt: Date;
  speaker: string;
  text: string;
  sourceLine: number;
  kind: "text" | "media_event" | "deleted_event";
};

export type ParseResult = {
  title: string;
  participants: string[];
  messages: ParsedMessage[];
  unparsedLines: Array<{ line: number; text: string }>;
};

export type ImportSummary = {
  roomId: string;
  insertedMessages: number;
  duplicateMessages: number;
  unparsedLines: Array<{ line: number; text: string }>;
};

export type ParsedTurn = {
  speaker: string;
  startedAt: Date;
  endedAt: Date;
  messages: ParsedMessage[];
};

export type ImportCommand = {
  title: string;
  selfName: string;
  rawText: string;
  existingRoomId?: string;
};
```

- [ ] **Step 1: Add realistic fixtures and failing parser tests**

Fixtures must cover Korean AM/PM timestamps, multiline messages, group senders, media placeholders, deleted messages, and a malformed line. Tests assert preserved source line numbers and that consecutive messages from the same speaker form one turn until another speaker replies.

```ts
const parsed = parseKakaoExport(fixture("one-to-one.txt"));
expect(parsed.title).toBe("민수와 카카오톡 대화");
expect(parsed.messages[0]).toMatchObject({ speaker: "민수", text: "거의 다 왔어 ㅋㅋ", sourceLine: 3 });
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/unit/kakao-parser.test.ts`

Expected: FAIL because parser modules do not exist.

- [ ] **Step 3: Implement the parser and turn grouping**

Use deterministic regular expressions for known Kakao headers and message lines. Preserve unknown lines in `unparsedLines`; never silently discard them. Treat media and deleted placeholders as non-text events. Compute a SHA-256 source fingerprint from normalized timestamp, speaker, kind, and text.

- [ ] **Step 4: Implement transactional idempotent import**

The service must create or resolve the room, resolve participants, insert encrypted messages with `ON CONFLICT DO NOTHING`, rebuild only turns affected by newly inserted messages, and return exact inserted and duplicate counts. The route accepts multipart field `file` and form field `selfName`, refuses files over 50 MiB with HTTP 413, and returns Zod validation errors with HTTP 400.

- [ ] **Step 5: Verify parser and import integration**

Run: `pnpm vitest run tests/unit/kakao-parser.test.ts tests/integration/import-service.test.ts`

Expected: all parsing tests pass; importing the same fixture twice reports zero new messages on the second import.

- [ ] **Step 6: Commit import support**

```bash
git add src/domain/kakao src/domain/imports src/app/api/imports tests/fixtures tests/unit/kakao-parser.test.ts tests/integration/import-service.test.ts
git commit -m "feat: import KakaoTalk conversation exports"
```

### Task 5: Conversation Chunking and Model Gateway

**Files:**
- Create: `src/domain/memory/chunker.ts`
- Create: `src/domain/models/gateway.ts`
- Create: `src/domain/models/openai-gateway.ts`
- Create: `tests/unit/chunker.test.ts`
- Create: `tests/unit/model-gateway.test.ts`

**Interfaces:**
- Consumes: parsed turns from Task 4 and encrypted persistence from Tasks 2 and 3.
- Produces: `chunkTurns(turns: ParsedTurn[], topicBoundaries: number[]): ConversationChunk[]`; `ModelGateway.extract<T>(request: StructuredModelRequest<T>): Promise<T>`; `ModelGateway.embed(texts: string[]): Promise<number[][]>`.

```ts
export type ConversationChunk = {
  startTurnIndex: number;
  endTurnIndex: number;
  startedAt: Date;
  endedAt: Date;
};

export type StructuredModelRequest<T> = {
  system: string;
  input: string;
  schemaName: string;
  schema: z.ZodType<T>;
};

export interface ModelGateway {
  extract<T>(request: StructuredModelRequest<T>): Promise<T>;
  embed(texts: string[]): Promise<number[][]>;
}
```

- [ ] **Step 1: Write failing deterministic chunking tests**

```ts
test("splits at thirty-minute gaps and explicit topic boundaries", () => {
  const chunks = chunkTurns(turnsAtMinutes([0, 2, 33, 34, 36]), [4]);
  expect(chunks.map(c => [c.startTurnIndex, c.endTurnIndex])).toEqual([[0, 1], [2, 3], [4, 4]]);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/unit/chunker.test.ts tests/unit/model-gateway.test.ts`

Expected: FAIL because the chunker and gateway do not exist.

- [ ] **Step 3: Implement deterministic chunking**

Split before a turn when the previous gap is at least 30 minutes, the calendar date changes in `Asia/Seoul`, or its index is in `topicBoundaries`. Validate boundaries are sorted unique integers inside the turn range.

- [ ] **Step 4: Implement the provider adapter**

The OpenAI-compatible adapter must request schema-constrained JSON, validate every response with the supplied Zod schema, retry once on rate limit or server errors, and throw `ModelResponseValidationError` without including prompts or response text. Batch embeddings in groups of 64. Read model names from `ANALYSIS_MODEL`, `REPLY_MODEL`, and `EMBEDDING_MODEL`.

- [ ] **Step 5: Verify gateway behavior**

Run: `pnpm vitest run tests/unit/chunker.test.ts tests/unit/model-gateway.test.ts`

Expected: chunk boundaries, schema validation, one retry, prompt-free errors, and embedding batches all pass with a mocked client.

- [ ] **Step 6: Commit chunking and model access**

```bash
git add src/domain/memory/chunker.ts src/domain/models tests/unit/chunker.test.ts tests/unit/model-gateway.test.ts
git commit -m "feat: add bounded conversation analysis gateway"
```

### Task 6: Hierarchical Memory and Editable Participant Profiles

**Files:**
- Create: `src/domain/memory/extractor.ts`
- Create: `src/domain/memory/profile-corrections.ts`
- Create: `src/domain/profiles/profile-service.ts`
- Create: `src/app/api/profiles/[participantId]/route.ts`
- Create: `src/app/api/profiles/[participantId]/chat/route.ts`
- Create: `tests/unit/profile-corrections.test.ts`
- Create: `tests/integration/profile-service.test.ts`

**Interfaces:**
- Consumes: `ModelGateway`, imported chunks, profile tables, and encryption.
- Produces: `extractRoomMemory(roomId: string): Promise<RoomMemoryResult>`, `applyProfileEdit(command: ProfileEditCommand): Promise<ProfileFactView>`, and `proposeProfileCorrection(input: CorrectionChatInput): Promise<CorrectionProposal>`.

Use these profile kinds exactly:

```ts
export const profileFactKinds = [
  "relationship", "personality_tendency", "speech_pattern", "conversation_role",
  "seriousness_cue", "preferred_interaction", "sensitive_topic", "interest",
  "nickname", "repeated_event", "conflict_response", "reconciliation_style"
] as const;

export type ProfileFactView = {
  id: string;
  participantId: string;
  kind: typeof profileFactKinds[number];
  value: string;
  conditions: string[];
  exceptions: string[];
  confidence: number;
  source: ProfileFactSource;
  locked: boolean;
  evidenceTurnIds: string[];
};

export type RoomMemoryResult = {
  roomId: string;
  updatedChunkIds: string[];
  proposedFacts: ProfileFactView[];
};

export type ProfileEditCommand = {
  participantId: string;
  factId?: string;
  kind: ProfileFactView["kind"];
  value: string;
  conditions: string[];
  exceptions: string[];
  action: "edit" | "confirm";
};

export type CorrectionChatInput = {
  participantId: string;
  userExplanation: string;
};

export type CorrectionProposal = {
  proposalId: string;
  participantId: string;
  factKind: ProfileFactView["kind"];
  oldValue: string | null;
  newValue: string;
  conditions: string[];
  exceptions: string[];
};
```

- [ ] **Step 1: Write failing correction precedence tests**

```ts
test("AI extraction cannot overwrite a locked user edit", () => {
  const merged = mergeProfileFact(
    { value: "장난이 적다", source: "user_edited", locked: true },
    { value: "장난이 많다", source: "ai_inference", confidence: 0.92 }
  );
  expect(merged.fact.value).toBe("장난이 적다");
  expect(merged.proposal?.value).toBe("장난이 많다");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/unit/profile-corrections.test.ts tests/integration/profile-service.test.ts`

Expected: FAIL because profile modules do not exist.

- [ ] **Step 3: Implement hierarchical extraction**

For each new or changed chunk, extract topic, event type, emotions, relationship signals, summary, and candidate profile facts with evidence turn IDs and confidence from 0 through 1. Then update topic memories and the room summary from child summaries. Encrypt summaries and fact values; embeddings use a redacted text with participant IDs instead of names.

- [ ] **Step 4: Implement edit and correction-chat flows**

Direct edits save `source="user_edited"`, `confidence=1`, and `locked=true`. User confirmations save `source="user_confirmed"`, `confidence=1`, and `locked=true`. Correction chat returns a preview containing `factKind`, `oldValue`, `newValue`, `conditions`, and `exceptions`; persist only after a separate confirmation request containing the proposal ID.

- [ ] **Step 5: Verify profile extraction and precedence**

Run: `pnpm vitest run tests/unit/profile-corrections.test.ts tests/integration/profile-service.test.ts`

Expected: locked facts survive reanalysis, conflicting AI results become proposals, and every AI fact has evidence plus confidence.

- [ ] **Step 6: Commit memory profiles**

```bash
git add src/domain/memory src/domain/profiles src/app/api/profiles tests/unit/profile-corrections.test.ts tests/integration/profile-service.test.ts
git commit -m "feat: build editable participant memories"
```

### Task 7: Adaptive Current Context and Relevant-Past Retrieval

**Files:**
- Create: `src/domain/replies/context-expander.ts`
- Create: `src/domain/retrieval/context-repository.ts`
- Create: `src/domain/retrieval/vector-context-repository.ts`
- Create: `tests/unit/context-expander.test.ts`
- Create: `tests/integration/context-repository.test.ts`

**Interfaces:**
- Consumes: message turns, chunks, embeddings, room memory, and participant profiles.
- Produces: `selectCurrentContext(input: ContextExpansionInput): Promise<CurrentContextSelection>` and `ContextRepository.findRelevant(query: ContextQuery): Promise<RetrievedChunk[]>`.

```ts
export type ContextSufficiency = {
  sufficient: boolean;
  ambiguityReasons: Array<"low_information" | "unclear_reference" | "past_event_missing" | "emotion_ambiguous" | "relationship_conflict">;
};

export type CurrentContextSelection = {
  turns: DecryptedTurn[];
  usedTurnLimit: 20 | 40 | 80 | "full_chunk";
  needsUserQuestion: boolean;
  question?: string;
};

export type ContextExpansionInput = {
  turns: DecryptedTurn[];
  fullChunkStart: number;
  judge: (turns: DecryptedTurn[]) => Promise<ContextSufficiency>;
};

export type DecryptedTurn = {
  id: string;
  speakerId: string;
  startedAt: Date;
  messages: Array<{ kind: "text" | "media_event" | "deleted_event"; text: string }>;
};

export type ContextQuery = {
  roomId: string;
  participantIds: string[];
  queryEmbedding: number[];
  topics: string[];
  eventTypes: string[];
  nicknames: string[];
  limit: 5;
};

export type RetrievedChunk = {
  chunkId: string;
  score: number;
  summary: string;
  turns: DecryptedTurn[];
};
```

- [ ] **Step 1: Write failing expansion tests**

```ts
test("expands only until context becomes sufficient", async () => {
  const judge = vi.fn()
    .mockResolvedValueOnce({ sufficient: false, ambiguityReasons: ["unclear_reference"] })
    .mockResolvedValueOnce({ sufficient: true, ambiguityReasons: [] });
  const result = await selectCurrentContext({ turns: makeTurns(100), judge, fullChunkStart: 0 });
  expect(judge).toHaveBeenCalledTimes(2);
  expect(result.usedTurnLimit).toBe(40);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/unit/context-expander.test.ts tests/integration/context-repository.test.ts`

Expected: FAIL because expansion and retrieval modules do not exist.

- [ ] **Step 3: Implement the 20/40/80/full expansion sequence**

Use deterministic low-information checks before calling the model: fewer than six lexical tokens, more than 70% event or laughter-only turns, and unresolved pronouns trigger expansion. At each limit ask the model for the exact `ContextSufficiency` schema. After `full_chunk`, produce one specific Korean clarification question from the ambiguity reasons instead of guessing.

- [ ] **Step 4: Implement hybrid retrieval**

Combine cosine similarity, matching participant IDs, topic tags, event types, recency decay, nickname matches, and sensitive-topic penalties. Return at most five chunks and never return chunks from another room. Decrypt only the selected chunks after ranking.

- [ ] **Step 5: Verify expansion and room isolation**

Run: `pnpm vitest run tests/unit/context-expander.test.ts tests/integration/context-repository.test.ts`

Expected: exact expansion limits pass, irrelevant history is excluded, and cross-room retrieval returns no rows.

- [ ] **Step 6: Commit context retrieval**

```bash
git add src/domain/replies/context-expander.ts src/domain/retrieval tests/unit/context-expander.test.ts tests/integration/context-repository.test.ts
git commit -m "feat: retrieve adaptive conversation context"
```

### Task 8: Woman-Speech Style Policy and Three-Reply Generation

**Files:**
- Create: `src/domain/replies/style-policy.ts`
- Create: `src/domain/replies/reply-service.ts`
- Create: `tests/unit/style-policy.test.ts`
- Create: `tests/integration/reply-service.test.ts`
- Create: `tests/fixtures/style-evaluation.json`

**Interfaces:**
- Consumes: `ModelGateway`, `CurrentContextSelection`, retrieved chunks, room memory, participant profiles, relationship style, and indirectness level.
- Produces: `buildStylePolicy(input: StylePolicyInput): StylePolicy`, `generateReplies(command: GenerateRepliesCommand): Promise<ReplyGenerationResult>`.

```ts
export type ReplyCandidate = {
  strategy: "relationship_soft" | "emotion_signal" | "clearer_request";
  text: string;
  intentLabel: string;
  riskLabel: string | null;
};

export type ReplyGenerationResult =
  | { kind: "clarification_required"; question: string }
  | { kind: "replies"; candidates: [ReplyCandidate, ReplyCandidate, ReplyCandidate] };

export type StylePolicyInput = {
  relationship: RelationshipStyle;
  indirectness: 1 | 2 | 3 | 4 | 5;
  intent: string;
};

export type StylePolicy = {
  indirectness: 1 | 2 | 3 | 4 | 5;
  relationship: RelationshipStyle;
  forbiddenCues: string[];
  allowedDevices: string[];
  mustRemainExplicit: boolean;
};

export type GenerateRepliesCommand = {
  roomId: string;
  participantId: string;
  pastedConversation: string;
  situation: string;
  intent: string;
  indirectness: 1 | 2 | 3 | 4 | 5;
};
```

- [ ] **Step 1: Write failing style-policy tests**

```ts
test("female-friend policy forbids romantic and jealousy cues", () => {
  const policy = buildStylePolicy({ relationship: "female_friend", indirectness: 4, intent: "apology_prompt" });
  expect(policy.forbiddenCues).toEqual(expect.arrayContaining(["romantic_affection", "jealousy", "exclusive_possession"]));
});

test("level five remains explicit for money and consent", () => {
  const policy = buildStylePolicy({ relationship: "girlfriend", indirectness: 5, intent: "money_refusal" });
  expect(policy.mustRemainExplicit).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/unit/style-policy.test.ts tests/integration/reply-service.test.ts`

Expected: FAIL because style and reply services do not exist.

- [ ] **Step 3: Implement policy construction**

Map levels 1 through 5 to decreasing direct-emotion vocabulary and increasing situation description, hedged questions, pauses, suggestions, and emotion clues. Allow laughter, vowel repetition, tildes, and emoji only when participant and room memories support them. Mark consent, safety, money, firm rejection, and important promises as explicit-intent categories.

- [ ] **Step 4: Implement structured generation and validation**

Request exactly three distinct strategies in the tuple order defined above. Reject output when candidate texts are identical after punctuation normalization, relationship-forbidden cues appear, current facts are contradicted, or an explicit-intent category loses its unambiguous decision. Retry once with validation errors expressed as rule IDs, never conversation text.

- [ ] **Step 5: Add the style evaluation fixture**

Create at least 24 fixed cases: four everyday, four lateness or promise conflicts, four refusals, four reconciliation cases, four attraction cases, and four money or consent cases. Every case specifies relationship style, indirectness, intent, forbidden cues, and required semantic outcome. Do not put real private conversations in the fixture.

- [ ] **Step 6: Verify generation**

Run: `pnpm vitest run tests/unit/style-policy.test.ts tests/integration/reply-service.test.ts`

Expected: exactly three ordered candidates, no romantic cues for friends, level differentiation, and explicit safety outcomes all pass.

- [ ] **Step 7: Commit the style engine**

```bash
git add src/domain/replies tests/unit/style-policy.test.ts tests/integration/reply-service.test.ts tests/fixtures/style-evaluation.json
git commit -m "feat: generate three context-aware woman-speech replies"
```

### Task 9: Authenticated API Orchestration and Deletion

**Files:**
- Create: `src/app/api/replies/route.ts`
- Create: `src/app/api/rooms/[roomId]/route.ts`
- Create: `src/lib/result.ts`
- Create: `tests/integration/replies-route.test.ts`
- Create: `tests/integration/room-deletion.test.ts`

**Interfaces:**
- Consumes: auth, profile, retrieval, and reply services.
- Produces: `POST /api/replies` and `DELETE /api/rooms/:roomId`.

- [ ] **Step 1: Write failing route tests**

```ts
test("reply API requires a session and returns exactly three candidates", async () => {
  expect((await postReply({ session: null })).status).toBe(401);
  const response = await postReply({ session: validSession(), body: validReplyBody() });
  expect(response.status).toBe(200);
  expect((await response.json()).candidates).toHaveLength(3);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/integration/replies-route.test.ts tests/integration/room-deletion.test.ts`

Expected: FAIL because the routes do not exist.

- [ ] **Step 3: Implement reply orchestration**

Validate `roomId`, `participantId`, pasted conversation, situation, intent, and optional indirectness 1 through 5 with Zod. Enforce a 50,000-character pasted-text limit. Use the participant's relationship style and account default indirectness when the request omits an override. Return HTTP 409 with `{ kind: "clarification_required", question }` when context is insufficient.

- [ ] **Step 4: Implement transactional room deletion**

Authenticate first, delete the room in one transaction, rely on foreign-key cascades for messages and derived memories, and enqueue deletion of associated encrypted upload blobs. Return HTTP 204. A second delete returns HTTP 404 without revealing other room IDs.

- [ ] **Step 5: Verify APIs and deletion**

Run: `pnpm vitest run tests/integration/replies-route.test.ts tests/integration/room-deletion.test.ts`

Expected: session enforcement, validation, clarification, three-reply success, cascade deletion, and idempotent-not-found behavior pass.

- [ ] **Step 6: Commit API orchestration**

```bash
git add src/app/api/replies src/app/api/rooms src/lib/result.ts tests/integration/replies-route.test.ts tests/integration/room-deletion.test.ts
git commit -m "feat: expose private reply and deletion APIs"
```

### Task 10: Mobile Room, Profile, and Reply Interfaces

**Files:**
- Create: `src/app/rooms/page.tsx`
- Create: `src/app/rooms/[roomId]/page.tsx`
- Create: `src/app/rooms/[roomId]/profiles/[participantId]/page.tsx`
- Create: `src/app/rooms/[roomId]/reply/page.tsx`
- Create: `src/components/bottom-nav.tsx`
- Create: `src/components/room-card.tsx`
- Create: `src/components/import-progress.tsx`
- Create: `src/components/profile-card.tsx`
- Create: `src/components/profile-editor.tsx`
- Create: `src/components/profile-correction-chat.tsx`
- Create: `src/components/reply-composer.tsx`
- Create: `src/components/reply-results.tsx`
- Create: `tests/unit/reply-composer.test.tsx`
- Create: `tests/unit/profile-editor.test.tsx`

**Interfaces:**
- Consumes: APIs from Tasks 4, 6, and 9.
- Produces: approved navigation flow `rooms → profile review → current context → three replies` on 360-pixel and wider screens.

- [ ] **Step 1: Write failing component tests**

```tsx
test("uses saved indirectness and allows a one-request override", async () => {
  render(<ReplyComposer roomId="r1" participantId="p1" defaultIndirectness={3} />);
  expect(screen.getByRole("slider", { name: "여자어 강도" })).toHaveValue("3");
  await userEvent.click(screen.getByLabelText("이번 답장만 강도 변경"));
  await userEvent.type(screen.getByRole("slider", { name: "여자어 강도" }), "4");
  expect(screen.getByText("기본 설정은 3단계로 유지됩니다.")).toBeVisible();
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/unit/reply-composer.test.tsx tests/unit/profile-editor.test.tsx`

Expected: FAIL because the UI components do not exist.

- [ ] **Step 3: Implement rooms and upload views**

Show room cards, analysis status, last-updated time, an upload button, unparsed-line review, self-name confirmation, and resumable progress. Use a bottom navigation with `대화방`, `친구 프로필`, and `설정`.

- [ ] **Step 4: Implement profile review views**

Render each fact with value, source, confidence, evidence count, conditions, exceptions, lock state, and edit action. Provide direct editing and correction chat as separate controls. Require explicit confirmation before applying a correction-chat proposal.

- [ ] **Step 5: Implement reply composition and results**

The composer contains pasted conversation, situation, inferred-or-selected intent, and indirectness override. Results render three strategy-labelled cards with intent, risk, edit, and copy actions. Clarification responses replace the result cards with one answer field and a retry button.

- [ ] **Step 6: Verify responsive UI and accessibility**

Run: `pnpm vitest run tests/unit/reply-composer.test.tsx tests/unit/profile-editor.test.tsx && pnpm build`

Expected: component tests pass, controls have Korean accessible names, no horizontal scroll at 360 pixels, and the production build succeeds.

- [ ] **Step 7: Commit mobile interfaces**

```bash
git add src/app/rooms src/components tests/unit/reply-composer.test.tsx tests/unit/profile-editor.test.tsx src/app/globals.css
git commit -m "feat: add mobile conversation and reply workflow"
```

### Task 11: End-to-End Private Workflow and Operational Hardening

**Files:**
- Create: `tests/e2e/private-reply-flow.spec.ts`
- Create: `tests/e2e/data-deletion.spec.ts`
- Create: `src/app/api/health/route.ts`
- Create: `docs/operations/private-deployment.md`
- Modify: `.env.example`
- Modify: `playwright.config.ts`

**Interfaces:**
- Consumes: complete application from Tasks 1 through 10.
- Produces: reproducible local deployment and browser-level verification of the private workflow.

- [ ] **Step 1: Write the failing end-to-end happy path**

```ts
test("imports a room, corrects a profile, and copies one of three replies", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "카카오톡 파일 업로드" }).setInputFiles("tests/fixtures/kakao/group-chat.txt");
  await page.getByLabel("내 이름").selectOption("나");
  await expect(page.getByText("분석 완료")).toBeVisible();
  await page.getByRole("link", { name: "민수 프로필" }).click();
  await page.getByRole("button", { name: "직접 수정" }).click();
  await page.getByLabel("관찰된 성향").fill("친한 사람에게만 장난이 많음");
  await page.getByRole("button", { name: "저장" }).click();
  await page.getByRole("link", { name: "답장 만들기" }).click();
  await page.getByLabel("현재 상황").fill("또 늦어서 서운하지만 싸우고 싶지는 않아");
  await page.getByRole("button", { name: "답장 3개 만들기" }).click();
  await expect(page.getByTestId("reply-candidate")).toHaveCount(3);
});
```

- [ ] **Step 2: Run E2E to verify failure**

Run: `pnpm test:e2e -- tests/e2e/private-reply-flow.spec.ts`

Expected: FAIL at the first missing or incorrect UI/API contract.

- [ ] **Step 3: Close integration gaps without changing domain contracts**

Fix wiring, loading states, transaction boundaries, and accessible labels exposed by the E2E test. Do not relax authentication, encryption, relationship, or explicit-intent rules to make the test pass.

- [ ] **Step 4: Add deletion and log-leak E2E tests**

Delete an imported room, verify it disappears, verify direct navigation returns 404, and query the test database to confirm messages, chunks, profile facts, requests, and candidates are gone. Capture server logs during a Korean private-message request and assert that no fixture message substring occurs.

- [ ] **Step 5: Document private deployment**

Document exact PostgreSQL setup, `CREATE EXTENSION vector`, environment key generation, Argon2 password-hash generation, migration command, model configuration, HTTPS reverse proxy requirement, backup encryption, restore test, and delete verification. State explicitly that the system is not end-to-end encrypted.

- [ ] **Step 6: Run the complete verification suite**

Run: `pnpm test && pnpm test:integration && pnpm test:e2e && pnpm build`

Expected: every unit, integration, and E2E test passes and the production build succeeds.

- [ ] **Step 7: Commit hardening and operations**

```bash
git add tests/e2e src/app/api/health docs/operations .env.example playwright.config.ts
git commit -m "test: verify private reply workflow end to end"
```

### Task 12: MVP Acceptance Review

**Files:**
- Create: `docs/acceptance/mvp-checklist.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: design spec and all implementation tasks.
- Produces: a checked acceptance record mapping every design requirement to executable evidence.

- [ ] **Step 1: Create the acceptance checklist with exact evidence commands**

Include one row for every item in design section 11. Each row contains requirement, test file, exact command, observed result, and commit hash. Add separate rows for friend/romantic separation, indirectness levels 1 through 5, encrypted storage, no plaintext logs, import idempotency, adaptive 20/40/80/full expansion, and deletion cascades.

- [ ] **Step 2: Run focused acceptance commands**

Run:

```bash
pnpm vitest run tests/integration/import-service.test.ts
pnpm vitest run tests/integration/profile-service.test.ts
pnpm vitest run tests/integration/reply-service.test.ts
pnpm vitest run tests/integration/room-deletion.test.ts
pnpm playwright test tests/e2e/private-reply-flow.spec.ts tests/e2e/data-deletion.spec.ts
pnpm build
```

Expected: every command exits 0. Record actual test counts and the current commit hash in `docs/acceptance/mvp-checklist.md`.

- [ ] **Step 3: Update README with the verified private workflow**

Document prerequisites, install, environment configuration, migration, dev server, full test commands, data deletion, privacy limitations, and the exact four-screen user flow. Do not advertise public multi-user readiness or end-to-end encryption.

- [ ] **Step 4: Re-run placeholder and privacy scans**

Run:

```bash
rg -n 'T''BD|T''ODO|F''IXME|implement l''ater' README.md docs src tests
rg -n "console\.(log|error)|JSON\.stringify\((message|profile|prompt)" src
```

Expected: no unresolved placeholders and no unsafe conversation logging. Any intentional `console` usage in framework bootstrap must be documented in the acceptance checklist and contain scalar operational metadata only.

- [ ] **Step 5: Commit acceptance evidence**

```bash
git add README.md docs/acceptance/mvp-checklist.md
git commit -m "docs: record MVP acceptance evidence"
```

- [ ] **Step 6: Confirm clean final state**

Run: `git status --short && git log --oneline -12`

Expected: empty status output and a reviewable sequence of task-scoped commits ending with `docs: record MVP acceptance evidence`.
