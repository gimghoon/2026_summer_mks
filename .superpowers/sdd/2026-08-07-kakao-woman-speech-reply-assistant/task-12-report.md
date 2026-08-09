# Task 12 report: MVP acceptance review

## Delivered

- Added a requirement-by-requirement acceptance record for every design section 11 item and every specifically requested privacy, style, context, import, and deletion requirement.
- Added an accurate private-workflow README covering prerequisites, install, environment, migration, development, the four-screen flow, test commands, deletion, and privacy limits.
- Allowed Playwright to use `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` and aligned its browser/readiness origin with Next's canonical `localhost` origin while keeping the server bound to `127.0.0.1`.
- Added a Playwright-origin regression test and tightened stale browser locators to their accessible roles and semantic regions.
- Strengthened the style fixture check to prove that levels 1 through 5 are all represented.

## Browser root-cause record

The first sandbox run could not bind `127.0.0.1:3210` and exited with `EPERM`. The escalated system-Chrome run launched but both tests remained on `/login`.

Evidence showed that the configured Argon2id hash matched `e2e-private-password`, and a direct login request under the same environment returned HTTP 303 with a Secure, HttpOnly, SameSite=Strict cookie. The Playwright trace showed Chrome blocking the `127.0.0.1` form POST under `form-action 'self'`, while Next canonicalized the response origin and redirect as `localhost`. Aligning Playwright's browser and readiness URLs to `localhost` fixed the origin mismatch without changing CSP or weakening authentication.

After login advanced, the browser exposed stale Task 11 locators: a paragraph treated as a heading, substring labels matching multiple controls, duplicate correction text, and two status roles. Each change was limited to selecting the current accessible UI contract; no product behavior was relaxed.

## Fresh verification

| Command group | Result |
| --- | --- |
| Four mandated focused integration commands | Import 2/2, profile 16/16, reply 13/13, room deletion 4/4. |
| Requirement-focused matrix | 11 files, 67/67 passed. |
| `pnpm test` | Final post-documentation rerun passed: 20 files, 86/86 tests. |
| `pnpm test:integration` | 9 files, 70/70 passed. |
| Bounded system-Chrome fixture Playwright | 2/2 passed. |
| `pnpm build` | Exit 0; production routes emitted. |
| `pnpm exec tsc --noEmit` | Exit 0 when run sequentially. One earlier parallel run raced with `next build` replacing `.next/types`; its generated-file errors were discarded, not represented as a source failure. |
| PostgreSQL safety | 1/1 safety test passed; safe URL discovery selected the one PostgreSQL deletion spec. |
| Live PostgreSQL | Not run: no `E2E_DATABASE_URL` or database was provisioned. The runner failed closed before Playwright as designed. |

The final reruns, privacy/placeholder scans, whitespace check, commit hash, and clean-state evidence are recorded in the acceptance checklist and final task handoff.
