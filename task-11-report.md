# Task 11 report — private workflow and operational hardening

## Delivered

- Added Playwright coverage for the private browser workflow:
  - password login;
  - Kakao `.txt` import and analysis;
  - room-scoped profile navigation;
  - direct profile edits;
  - correction-chat proposal plus explicit confirmation;
  - three reply candidates, clipboard copy, clarification, and retry;
  - room deletion, direct-navigation 404, and zero remaining derived-record counts.
- Added an explicitly non-production (`NODE_ENV !== "production"` and `E2E_FIXTURE_MODE=1`) encrypted in-memory adapter so ordinary E2E tests do not require PostgreSQL, OpenAI, or network access. Production builds always select the PostgreSQL/OpenAI adapters.
- Added `/api/health`; its public response contains only `{ "status": "ok" }`. Authenticated per-room counts exist only while the non-production E2E adapter is enabled.
- Normalized auth-first API behavior so import, analysis, profile, and correction routes return the session's 401 response before parsing or reading a request body.
- Added streaming request limits: login 8 KiB; profile edit and correction 64 KiB; existing import (50 MiB file/bounded multipart) and reply (512 KiB/50,000 characters) limits remain enforced.
- Added a bounded UTF-8/JSON request reader and profile field/array limits.
- Added CSP, framing, MIME-sniffing, referrer, permissions, opener, and production HSTS headers.
- Strengthened privacy tests for auth-first body handling, encrypted-at-rest payloads, cross-room participant isolation, cascade deletion, safe Korean-message logging, safe errors, prompt-free retries, and existing import/reply size boundaries.
- Expanded `.env.example` and added an exact private deployment runbook covering PostgreSQL/pgvector, extensions, key and Argon2id generation, migration, model configuration, HTTPS proxying, proxy rate limits, encrypted backups, restore drills, and delete verification. The runbook states explicitly that the system is not end-to-end encrypted.

## Verification evidence

- Focused hardening: 5 files, 25 tests passed.
- Full unit suite: 18 files, 83 tests passed.
- Full integration suite: 9 files, 70 tests passed.
- TypeScript: `tsc --noEmit` passed.
- Production build: Next.js compiled, typechecked, generated 12 static pages, and completed successfully.
- Playwright discovery: 2 tests in 2 files listed successfully.
- Placeholder/privacy scan: no source placeholders or unsafe application logging matches. The only `console.log` match is the documented one-line Argon2 hash generator command.
- `git diff --check`: passed.

## Browser and environment limitation

The first Playwright execution could not start the local Next server because the workspace sandbox rejected `listen 127.0.0.1:3210` with `EPERM`; Chromium never launched. An approved retry returned no usable output before being interrupted. A subsequent filesystem check found no Playwright Chromium/headless-shell executable in the local browser cache, and network installation is unavailable. Therefore no browser-pass claim is made. The test configuration and both specs were validated through Playwright's `--list` mode, while all route/store behavior used by the specs is covered by the passing offline integration suite.

## Self-review and residual operational checks

- The test adapter cannot be enabled in a production Next process and does not bypass session, schema, encryption, relationship, or explicit-confirmation boundaries.
- The health endpoint discloses no database configuration or private state in production.
- Rate limiting is intentionally specified at the durable reverse-proxy/gateway layer; an in-process limiter would not be reliable across restarts or replicas.
- PostgreSQL foreign-key cascades are represented in the migration/schema and exercised through controlled adapter counts, but a real PostgreSQL deletion smoke test still requires a provisioned staging database.
- A live model smoke test remains a deployment check and must use synthetic conversations, not private user data.
- The user-approved implement-then-verify ruling was followed instead of strict red-first TDD.
