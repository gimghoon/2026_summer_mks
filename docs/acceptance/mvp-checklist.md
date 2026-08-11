# MVP acceptance checklist

## Evidence boundary

- Verified source base: `e79f8d6` plus the final-blocker implementation diff described in `final-blockers-report.md`.
- Evidence date: 2026-08-10, Asia/Seoul.
- Required-personal-context addendum source base: `ea7a39c` plus the Task 5 implementation diff.
- Required-personal-context addendum evidence date: 2026-08-12, Asia/Seoul.
- The Task 5 shell exposed Node directly, so C23-C32 record the exact commands without the earlier runtime-path preamble.
- Runtime preamble for every pnpm command: `PATH=/Users/gimghoon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH` because the desktop shell did not expose `node` directly.
- Each row names a literal command ID from the command register below. The source hash is repeated per requirement as requested; the final documentation commit cannot contain its own hash without changing that hash.

## Command register

| ID | Exact command | Observed result |
| --- | --- | --- |
| C1 | `PATH=/Users/gimghoon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH pnpm vitest run tests/integration/import-service.test.ts` | Exit 0; 1 file, 2 tests passed. |
| C2 | `PATH=/Users/gimghoon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH pnpm vitest run tests/integration/profile-service.test.ts` | Exit 0; 1 file, 16 tests passed. |
| C3 | `PATH=/Users/gimghoon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH pnpm vitest run tests/integration/reply-service.test.ts` | Exit 0; 1 file, 13 tests passed. |
| C4 | `PATH=/Users/gimghoon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH pnpm vitest run tests/integration/room-deletion.test.ts` | Exit 0; 1 file, 4 tests passed. |
| C5 | `PATH=/Users/gimghoon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH pnpm vitest run tests/unit/kakao-parser.test.ts tests/unit/context-expander.test.ts tests/unit/style-policy.test.ts tests/unit/encrypted-json.test.ts tests/unit/schema-contract.test.ts tests/unit/logger.test.ts tests/unit/playwright-config.test.ts tests/integration/context-repository.test.ts tests/integration/private-workflow-security.test.ts tests/integration/reply-production-policy.test.ts tests/integration/replies-route.test.ts` | Exit 0; 11 files, 67 tests passed. |
| C6 | `PATH=/Users/gimghoon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' /usr/bin/perl -e '$SIG{ALRM}=sub{die "bounded E2E timeout after 180 seconds\n"}; alarm 180; exec @ARGV or die $!' pnpm playwright test tests/e2e/private-reply-flow.spec.ts tests/e2e/data-deletion.spec.ts` | Exit 0 outside the port-binding sandbox; 2 browser tests passed in system Chrome. |
| C7 | `PATH=/Users/gimghoon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH pnpm test` | Exit 0; 20 files, 86 unit tests passed. |
| C8 | `PATH=/Users/gimghoon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH pnpm test:integration` | Exit 0; 9 files, 70 integration tests passed. |
| C9 | `PATH=/Users/gimghoon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH pnpm exec tsc --noEmit` | Exit 0 when run sequentially after build artifact generation. |
| C10 | `PATH=/Users/gimghoon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH pnpm build` | Exit 0; production compilation, type validation, page generation, and route emission completed. |
| C11 | `PATH=/Users/gimghoon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH pnpm vitest run tests/unit/postgres-e2e-safety.test.ts` | Exit 0; 1 safety test passed. |
| C12 | `PATH=/Users/gimghoon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH E2E_DATABASE_URL='postgresql://fixture:fixture@127.0.0.1:5432/private_reply_e2e_test' pnpm playwright test --list` | Exit 0; PostgreSQL mode selected only `postgres-data-deletion.spec.ts` (1 test). Discovery only; no connection was made. |
| C13 | `PATH=/Users/gimghoon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH pnpm test:e2e:postgres` | Exit 1 before Playwright: `E2E_DATABASE_URL is required for PostgreSQL deletion E2E`. No PostgreSQL database was provisioned, so no live PostgreSQL result is claimed. |
| C14 | `rg -n 'T''BD|T''ODO|F''IXME|implement l''ater' README.md docs src tests` | Exit 1 with no matches. |
| C15 | `rg -n "console\.(log|error)|JSON\.stringify\((message|profile|prompt)" src` | Exit 1 with no matches. No framework-bootstrap exception was needed. |
| C16 | `PATH=/Users/gimghoon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH pnpm vitest run tests/unit/production-start.test.ts tests/unit/kakao-parser.test.ts tests/unit/import-route.test.ts tests/unit/rooms-workspace.test.tsx tests/integration/import-service.test.ts tests/integration/chunk-reconciliation.test.ts tests/integration/context-repository.test.ts tests/integration/production-reply-context.test.ts tests/integration/private-workflow-security.test.ts tests/integration/reply-production-policy.test.ts tests/integration/reply-service.test.ts` | Exit 0; 11 files, 57 final-blocker regressions passed. |
| C17 | `PATH=/Users/gimghoon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH pnpm test` | Exit 0; 21 files, 92 unit tests passed. |
| C18 | `PATH=/Users/gimghoon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH pnpm test:integration` | Exit 0; 11 files, 78 integration tests passed. |
| C19 | `PATH=/Users/gimghoon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH pnpm exec tsc --noEmit` | Exit 0, run sequentially after the production build. |
| C20 | `PATH=/Users/gimghoon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH pnpm build` | Exit 0; production compilation, type validation, static generation, and route emission completed. |
| C21 | Fixture environment plus `pnpm start --hostname 127.0.0.1 --port 3321`, followed by `curl --fail --silent http://127.0.0.1:3321/api/health` | Outside the port-binding sandbox, Next production mode reached Ready in 243 ms and health returned `{"status":"ok"}`; the server was then stopped. |
| C22 | `PATH=/Users/gimghoon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' /usr/bin/perl -e '$SIG{ALRM}=sub{die "bounded E2E timeout after 180 seconds\n"}; alarm 180; exec @ARGV or die $!' pnpm playwright test tests/e2e/private-reply-flow.spec.ts tests/e2e/data-deletion.spec.ts` | Exit 0 outside the port-binding sandbox; 2/2 system-Chrome fixture tests passed in 13.3 seconds. |
| C23 | `pnpm exec vitest run tests/unit/required-personal-context.test.ts tests/unit/personal-context-usage-validator.test.ts tests/unit/reply-evidence.test.ts tests/unit/reply-composer.test.tsx tests/unit/reply-results.test.tsx tests/unit/schema-contract.test.ts tests/unit/e2e-fixture-store.test.ts tests/integration/reply-service.test.ts tests/integration/replies-route.test.ts tests/integration/production-reply-context.test.ts tests/integration/reply-production-policy.test.ts tests/integration/private-workflow-security.test.ts` | Exit 0; 12 files, 143 tests passed. |
| C24 | `pnpm exec vitest run tests/unit` | Exit 0; 29 files, 178 tests passed. |
| C25 | `pnpm exec vitest run tests/integration` | Exit 0; 13 files, 149 tests passed. |
| C26 | `pnpm exec tsc --noEmit` | Exit 0 after correcting the fixture helper to consume the shared selector's `ParticipantProfileContext[]` result. |
| C27 | `pnpm exec drizzle-kit check --config=drizzle.config.ts` | Exit 0; Drizzle reported `Everything's fine`. |
| C28 | `pnpm build` | Exit 0; production compilation, type validation, static generation, and route emission completed. |
| C29 | `pnpm exec playwright test --list` | Exit 0; 2 fixture tests discovered, including the expanded private reply flow. |
| C30 | `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm exec playwright test tests/e2e/private-reply-flow.spec.ts` | Exit 0; 1/1 system-Chrome browser test passed in 10.1 seconds. The unconfigured command could not launch because Playwright's cached Chromium executable was absent. |
| C31 | `git diff --check` | Exit 0 with no output. |
| C32 | `rg -n "console\.(log|debug)|selectedFacts|semantic.*explanation|raw.*model|profile.*value" src/app/api/replies src/domain/replies src/components` | Exit 0 with 11 reviewed internal/UI matches; no console logging, semantic-explanation field, raw model output, client response field, retry rule, or plaintext database column exposed private profile values. |

## Design section 11 acceptance mapping

| # | Requirement | Test file(s) | Exact command | Observed result | Commit hash |
| --- | --- | --- | --- | --- | --- |
| 1 | Parse KakaoTalk `.txt` and handle an additional upload to the same room. | `tests/unit/kakao-parser.test.ts`, `tests/unit/import-route.test.ts`, `tests/unit/rooms-workspace.test.tsx`, `tests/integration/import-service.test.ts`, `tests/integration/private-workflow-security.test.ts` | C16 | Pass: the UI can select an existing room, the API validates its UUID and existence, production and fixture adapters reuse that room, identical repeats persist with occurrence ordinals, and full-export reimport is idempotent. | `e79f8d6` + final-blocker diff |
| 2 | Produce long-term room memory and evidence-backed participant profiles. | `tests/integration/profile-service.test.ts` | C2 | Pass: 16/16 cover hierarchical memory, evidence, confidence, provenance, encryption, retries, and rollback. | `f5b4069` + Task 12 diff |
| 3 | Support both direct profile editing and confirmed AI correction chat. | `tests/integration/profile-service.test.ts`, `tests/e2e/private-reply-flow.spec.ts` | C2, C6 | Pass: direct locked edits, proposed corrections, explicit confirmation, and browser persistence all completed. | `f5b4069` + Task 12 diff |
| 4 | Accept current conversation, situation, and reply purpose. | `tests/integration/replies-route.test.ts`, `tests/e2e/private-reply-flow.spec.ts` | C5, C6 | Pass: strict request validation and the browser composer flow completed. | `f5b4069` + Task 12 diff |
| 5 | Adaptive current-context selection and relevant past retrieval work. | `tests/unit/context-expander.test.ts`, `tests/integration/production-reply-context.test.ts`, `tests/integration/context-repository.test.ts`, `tests/integration/reply-production-policy.test.ts` | C16 | Pass: pasted speaker lines become turns, 20/40/80/full selection remains covered, only selected current plaintext reaches embedding/reply providers, real chunk turns and metadata populate hybrid retrieval, and group history requires the target participant. | `e79f8d6` + final-blocker diff |
| 6 | Generate three strategically different replies at the selected indirectness. | `tests/unit/style-policy.test.ts`, `tests/integration/reply-service.test.ts`, `tests/e2e/private-reply-flow.spec.ts` | C3, C5, C6 | Pass: C3 passed 13/13 and browser output contained exactly three candidates with generation and clarification paths. | `f5b4069` + Task 12 diff |
| 7 | Keep female-friend and girlfriend styles separate. | `tests/unit/style-policy.test.ts`, `tests/integration/reply-service.test.ts`, `tests/fixtures/style-evaluation.json` | C3, C5 | Pass: friend romantic/jealous/possessive cues are forbidden; the fixture covers both relationship modes. | `f5b4069` + Task 12 diff |
| 8 | Delete source and analyzed data, and support analysis replay. | `tests/integration/room-deletion.test.ts`, `tests/integration/profile-service.test.ts`, `tests/integration/chunk-reconciliation.test.ts`, `tests/integration/import-service.test.ts`, `tests/e2e/data-deletion.spec.ts` | C16, C18, C22 | Pass in integration and encrypted fixture-browser modes: incremental import/reanalysis reuses stable chunk lineage, produces no duplicate partitions, and readiness requires exact-once turn coverage. Deletion counts reached zero. Live PostgreSQL is tracked separately below. | `e79f8d6` + final-blocker diff |
| 9 | Prepared evaluations do not mix people, relationships, or events. | `tests/integration/profile-service.test.ts`, `tests/integration/context-repository.test.ts`, `tests/unit/style-policy.test.ts`, `tests/fixtures/style-evaluation.json` | C2, C5 | Pass: cross-participant/cross-kind targets are rejected, retrieval is room-local, and 24 synthetic cases carry explicit relationship and semantic outcome fields. | `f5b4069` + Task 12 diff |
| 10 | Conversation plaintext is absent from logs and stored private data is encrypted. | `tests/unit/encrypted-json.test.ts`, `tests/unit/logger.test.ts`, `tests/integration/private-workflow-security.test.ts` | C5, C15 | Pass: encryption round trips without plaintext leakage, logger metadata is scalar-only, fixture storage contains no private substrings, and the source scan found no unsafe logging call. | `f5b4069` + Task 12 diff |

## Explicit supplemental requirements

| Requirement | Test file(s) | Exact command | Observed result | Commit hash |
| --- | --- | --- | --- | --- |
| Female-friend / girlfriend separation | `tests/unit/style-policy.test.ts`, `tests/integration/reply-service.test.ts`, `tests/fixtures/style-evaluation.json` | C3, C5 | Pass: friend-only prohibitions and both relationship fixture modes verified. | `f5b4069` + Task 12 diff |
| Indirectness level 1 | `tests/unit/style-policy.test.ts`, `tests/fixtures/style-evaluation.json` | C5 | Pass: fixture level set is exactly 1–5; level 1 direct-device policy is exercised. | `f5b4069` + Task 12 diff |
| Indirectness level 2 | `tests/unit/style-policy.test.ts`, `tests/fixtures/style-evaluation.json` | C5 | Pass: fixture level set is exactly 1–5 and contains level 2 cases. | `f5b4069` + Task 12 diff |
| Indirectness level 3 | `tests/unit/style-policy.test.ts`, `tests/fixtures/style-evaluation.json` | C5 | Pass: fixture level set is exactly 1–5 and contains default level 3 cases. | `f5b4069` + Task 12 diff |
| Indirectness level 4 | `tests/unit/style-policy.test.ts`, `tests/fixtures/style-evaluation.json` | C5 | Pass: fixture level set is exactly 1–5 and contains level 4 emotion-clue cases. | `f5b4069` + Task 12 diff |
| Indirectness level 5 | `tests/unit/style-policy.test.ts`, `tests/integration/reply-service.test.ts`, `tests/fixtures/style-evaluation.json` | C3, C5 | Pass: level 5 remains explicit for money, consent, safety, rejection, and important promises. | `f5b4069` + Task 12 diff |
| Encrypted storage | `tests/unit/encrypted-json.test.ts`, `tests/integration/private-workflow-security.test.ts`, `tests/integration/profile-service.test.ts` | C2, C5 | Pass: AES-GCM payloads hide Korean plaintext; stored fixture and profile payloads are encrypted. | `f5b4069` + Task 12 diff |
| No plaintext logs | `tests/unit/logger.test.ts`, `tests/integration/replies-route.test.ts` | C5, C15 | Pass: scalar-only metadata tests passed and the privacy scan returned no matches. | `f5b4069` + Task 12 diff |
| Import idempotency | `tests/integration/import-service.test.ts`, `tests/unit/kakao-parser.test.ts`, `tests/unit/schema-contract.test.ts` | C16 | Pass: occurrence ordinals preserve legitimate identical same-minute messages while a full-export reimport stores no duplicates; schema uniqueness remains the final database guard. | `e79f8d6` + final-blocker diff |
| Adaptive 20 / 40 / 80 / full expansion | `tests/unit/context-expander.test.ts`, `tests/integration/production-reply-context.test.ts` | C16 | Pass: the complete expansion sequence remains asserted and production selects parsed turns; the provider-minimization regression proves unselected paste text is absent from both embedding and reply requests. | `e79f8d6` + final-blocker diff |
| Incremental analysis coverage | `tests/integration/import-service.test.ts`, `tests/integration/chunk-reconciliation.test.ts` | C16 | Pass: import then reanalysis retains stable partitions and old analysis lineage where possible, creates appended partitions, rejects duplicate/overlapping coverage, and converges without duplicate chunks. | `e79f8d6` + final-blocker diff |
| Production start command | `tests/unit/production-start.test.ts` | C16, C20, C21 | Pass: `pnpm start --help` invokes Next production mode, the app builds, starts, becomes ready, and serves the health endpoint. | `e79f8d6` + final-blocker diff |
| Production hybrid retrieval wiring | `tests/integration/production-reply-context.test.ts`, `tests/integration/context-repository.test.ts` | C16 | Pass: decrypted chunk summaries/turns plus participant, topic, event, nickname, relationship, and sensitive metadata populate candidates and queries; group retrieval excludes a semantically similar chunk for the wrong person. | `e79f8d6` + final-blocker diff |
| Deletion cascades | `tests/unit/schema-contract.test.ts`, `tests/integration/room-deletion.test.ts`, `tests/e2e/data-deletion.spec.ts` | C4, C5, C6 | Pass for schema, route, and encrypted fixture-browser modes; all fixture counts reached zero. | `f5b4069` + Task 12 diff |

## Required personal context mode addendum

| Requirement | Evidence | Observed result | Commit hash |
| --- | --- | --- | --- |
| Verified facts appear in every required-mode candidate | `tests/unit/e2e-fixture-store.test.ts`, `tests/e2e/private-reply-flow.spec.ts`; C23, C30 | Pass: all three strategy-distinct fixture texts reflect a selected verified fact and display stable, non-fallback evidence. | `ea7a39c` + Task 5 diff |
| AI-only fallback is explicit | `tests/unit/e2e-fixture-store.test.ts`, `tests/e2e/private-reply-flow.spec.ts`; C23, C30 | Pass: every AI-only candidate carries the public `unverified_profile_context` warning and the browser renders it on all three cards. | `ea7a39c` + Task 5 diff |
| Missing eligible facts recover without persistence | `tests/unit/e2e-fixture-store.test.ts`, `tests/e2e/private-reply-flow.spec.ts`; C23, C30 | Pass: required mode returns the exact typed unavailable result before request storage; the browser shows the exact message and opens the selected empty profile via `프로필 확인하기`. | `ea7a39c` + Task 5 diff |
| Required mode is remembered | `tests/e2e/private-reply-flow.spec.ts`; C30 | Pass: the checked state survives reload and remains enabled when changing among verified, inferred, and empty-profile participants. | `ea7a39c` + Task 5 diff |
| Fixture storage matches the encrypted public contract | `tests/unit/e2e-fixture-store.test.ts`; C23, C32 | Pass: successful fixture requests store `personalContextMode` as an encrypted JSON payload; unavailable requests store nothing, and raw fixture payloads contain no plaintext mode value. | `ea7a39c` + Task 5 diff |
| Normal fixture behavior is unchanged | `tests/unit/e2e-fixture-store.test.ts`; C23 | Pass: the three original texts, clarification result, indirectness warnings, and successful request count remain exact in normal mode. | `ea7a39c` + Task 5 diff |

## PostgreSQL mode and deployment gate

PostgreSQL safety and discovery are verified by C11 and C12. C13 proves the runner fails closed when no dedicated test database URL is supplied. Because this workspace has no provisioned PostgreSQL database, `postgres-data-deletion.spec.ts` was not executed and no live PostgreSQL cascade claim is made. Before private deployment, provision a disposable database whose name contains a standalone `test` marker and run `pnpm test:e2e:postgres`; that command must exit 0.

## Overall result

The final-blocker focused suite, full unit and integration suites, typecheck, production build/start health smoke, and encrypted system-Chrome fixture-browser gates pass for this private single-user MVP. Live PostgreSQL deletion remains an explicit deployment-environment gate rather than fabricated local evidence.
