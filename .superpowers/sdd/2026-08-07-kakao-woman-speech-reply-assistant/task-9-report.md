# Task 9 Report: Authenticated Reply and Deletion APIs

## Status

Implemented and verified in the assigned worktree.

## Delivered

- `POST /api/replies` authenticates before reading the request body; parses only bounded JSON; validates a strict Zod object; limits pasted conversation text to 50,000 characters; and rejects oversized request bodies with HTTP 413.
- The reply endpoint verifies that the requested participant belongs to the requested room before generating or persisting anything. It uses that participant's relationship style, defaults an omitted indirectness value to the single-user application default of level 3, returns clarification requests as HTTP 409, and otherwise returns exactly the generated candidates.
- Reply requests and candidates are encrypted before persistence. The persistence transaction repeats the room/participant containment check to prevent a mismatched row from being created during a concurrent deletion.
- Production context includes room-local turns, room memory, participant profile facts, and room-local vector retrieval. No request body or model/context text is logged; failure logs contain only identifiers and an error class name.
- `DELETE /api/rooms/:roomId` authenticates first, treats malformed and missing IDs uniformly as HTTP 404, deletes only the requested room in one database transaction, and relies on the existing foreign-key cascades for all messages and derived records. A repeated deletion returns HTTP 404.
- Added a compact `Result` utility for expected parsing failures. Route factories live outside Next route modules so integration tests can exercise the real HTTP boundary while the route modules export only valid HTTP handlers.

## Focused tests

- `tests/integration/replies-route.test.ts`: unauthenticated access, default indirectness, three candidates, pasted-text limit, clarification response, room/participant isolation, and private-error redaction.
- `tests/integration/room-deletion.test.ts`: auth-first behavior, one scoped deletion and cleanup dispatch, repeated-delete 404, and invalid-ID indistinguishability.

## Fresh verification

| Command | Outcome |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run tests/integration/replies-route.test.ts tests/integration/room-deletion.test.ts` | Passed: 2 files, 10 tests. |
| `node node_modules/typescript/bin/tsc --noEmit` | Passed. |
| `node node_modules/next/dist/bin/next build` | Passed; both new API routes were emitted as dynamic routes. |
| `node node_modules/vitest/vitest.mjs run` | Passed: 19 files, 123 tests. |
| `git diff --check` | Passed with no whitespace errors. |

## Self-review

- Authentication precedes body parsing and all room lookups.
- The participant lookup and persistence transaction both require the same room ID, so a participant ID from another room cannot be used to retrieve or write reply data.
- Room deletion's `WHERE` clause is limited to the requested room ID; foreign-key cascades are configured in the existing schema, so no unrelated room is touched.
- Responses and logs do not echo pasted conversation, situation, intent, profile facts, model responses, or thrown error messages.
- The Next route-export contract was verified with a production build after moving test factories to domain helpers.

## Schema-limited follow-up

This is a single-user application: sessions identify access to the private deployment, while the schema has no account table or account-level indirectness setting. Consequently level 3 is the conservative application default. Imports also parse and persist conversation data directly in PostgreSQL; no upload-blob table or blob key currently exists. The deletion handler has a cleanup queue boundary, which is a no-op until a blob store is added; the transaction already deletes every currently persisted room record through schema cascades.

## Fix Round 1: Submitted Context and Fact Validation

- The production context adapter now appends a synthetic newest turn containing the submitted pasted conversation, situation, and intent before calling adaptive context selection. Its judge requires sufficient submitted detail, so a semantically complete new-room request can generate while sparse requests still produce one clarification even if old room history is long.
- Replaced the production no-op fact validator with `validatesReplyFact`. It compares generated text only against decrypted reviewed profile facts, room memory, selected current turns, and retrieved context; it currently rejects explicit opposite-polarity claims sharing a factual anchor (for example, a reviewed `likes coffee` fact versus a generated `dislikes coffee` claim). It returns only a boolean, preserving the reply service's opaque `FACT_CONTRADICTION` retry metadata and never logging private text.
- Added `tests/integration/reply-production-policy.test.ts` to exercise the production context policy for complete and sparse submitted exchanges, profile/current-context contradictions, and a generation retry that carries only `FACT_CONTRADICTION` rather than rejected candidate text.

### Fix round verification

| Command | Outcome |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run tests/integration/reply-production-policy.test.ts tests/integration/replies-route.test.ts tests/integration/reply-service.test.ts` | Passed: 3 files, 24 tests. |
| `node node_modules/typescript/bin/tsc --noEmit` | Passed. |
| `node node_modules/vitest/vitest.mjs run` | Passed: 20 files, 128 tests. |
| `node node_modules/next/dist/bin/next build` | Passed. |
| `git diff --check` | Passed with no whitespace errors. |
