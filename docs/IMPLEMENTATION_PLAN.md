# Scholar AI — Phased Implementation Plan and Gate Tracker

Source of truth: [`SCHOLAR_AI_PLAN.md`](../SCHOLAR_AI_PLAN.md). That blueprint is itself a
reconstruction (see its §1); if the original finalized plan surfaces, diff it against §1
before changing scope. This file maps the blueprint's milestones M0–M6 onto build phases and
records which completion gates have actually passed. A gate is marked passed only with
evidence (a test, a command, or a recorded live check). A mocked check never counts as a
live provider check.

Legend: `[x]` done and verified · `[ ]` not done · `[~]` partially done (see note) ·
`BLOCKED` waiting on an external prerequisite.

---

## Phase overview

| Phase | Blueprint milestone(s)        | Outcome                                                                                           | External prerequisites                                                   |
| ----- | ----------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **1** | **M0 + first vertical slice** | Workspace, DB, auth skeleton, mock Google Tasks adapter, durable worker, fixture-backed dashboard | None (mock mode)                                                         |
| 2     | M1                            | Real read-only Google Tasks OAuth, encrypted tokens, live sync, reconnect                         | Google Cloud project, OAuth client, consent screen, test user            |
| 3     | M2                            | Canvas read-only context via institution OAuth, matching, manual fallback                         | Institution developer key + base URL **or** decision to ship manual mode |
| 4     | M3                            | Immutable proposals, approvals, budgets, validated AI artifacts                                   | Anthropic API key, model ID, spend limit                                 |
| 5     | M4                            | Study system (packs, practice, schedules)                                                         | Same as Phase 4                                                          |
| 6     | M5                            | Separately approved Google Task completion                                                        | Incremental Tasks write consent on a disposable test task                |
| 7     | M6                            | Production readiness (deploy, backups, deletion/export, runbooks)                                 | Host, managed secrets/KMS, owner approval to deploy                      |

**Deployment rule:** nothing is deployed publicly without the owner's explicit approval.
Phases 1–6 run locally or in CI only.

---

## Phase 1 — M0 + first vertical slice (signed-in user → fixture Tasks → persisted dashboard)

Why the slice is in Phase 1: the blueprint's build instructions (§12, step 3) require the
smallest vertical slice before real OAuth. M0's "mock adapters" and "auth skeleton" are only
meaningfully verified by driving data through them end to end.

### Scope

- [x] npm workspace (`apps/web`, `apps/worker`, `packages/*`), pinned versions, lockfile
- [x] `.env.example` with empty secrets; startup validation that fails production on mock
      mode, missing/weak secrets, unsafe defaults, or premature write enabling
- [x] Local PostgreSQL via `infra/compose.yml`; Prisma migrations; idempotent synthetic seed
- [x] Auth skeleton (Better Auth): mock-mode demo sign-in (verified by e2e)
- [~] Google identity sign-in wired for live mode with OpenID scopes only — **not yet exercised
  against a real Google project** (needs owner's OAuth client; Phase 2 smoke test)
- [x] Owner-scoped data access; composite ownership foreign keys
- [x] Mock Google Tasks adapter, clearly labelled, with pagination, completed/hidden/deleted
      items, and failure injection
- [x] Durable PostgreSQL job queue (dedupe keys, `FOR UPDATE SKIP LOCKED`, leases,
      fencing, bounded retry with jitter, lease recovery)
- [x] Worker: job runner, scheduler (15-minute default with jitter), heartbeat, graceful stop
- [x] Sync: staged per-list commits, cursor advanced only after commit, full-scan-only
      disappearance, tombstones, `last_attempt_at` vs `last_success_at`
- [x] Web: onboarding (timezone, connect mock Tasks, select lists), dashboard (overdue, today,
      upcoming, no date, completed), sync status and stale warnings, settings, disconnect
- [x] API v1 subset with `{data, requestId}` envelope, origin-based CSRF check, rate limits
- [x] Health endpoint (DB + worker heartbeat, no user data)
- [x] Provider access checklist with Canvas availability explicitly recorded
- [~] CI workflow (format, lint, type-check, unit, integration, e2e, build) — written; first
  GitHub run is on the Phase 1 pull request against `main`; mark done only once it is green

### M0 completion gate

| Gate                                    | Status | Evidence                                                                               |
| --------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| App and worker start from README        | [x]    | README sequence run against `infra/compose.yml` Postgres; e2e suite starts both itself |
| Health checks pass                      | [x]    | `GET /api/health` → `{status:"ok"}` with fresh worker heartbeat (e2e `health.spec.ts`) |
| Unknown secrets absent from source      | [x]    | `.env.example` secrets empty; `.env*` ignored; config tests                            |
| Canvas availability explicitly recorded | [x]    | [`PROVIDER_ACCESS.md`](PROVIDER_ACCESS.md): **not established**                        |

### Acceptance cases exercised in Phase 1 (fixture level only)

| ID  | Coverage now                                                                               | Still required later                           |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| A01 | Unauthenticated API → 401; cross-user task/integration/job IDs → 404 (integration + e2e)   | Every nested resource added in later phases    |
| A04 | Date-only due date shows Nov 5 for New York and Tokyo (unit + integration)                 | Live Google account check (Phase 2)            |
| A05 | Pagination, completed/hidden/deleted, repeat sync no duplicates (integration, mock)        | Live account (Phase 2)                         |
| A06 | Mid-pagination failure: no partial commit, cursor kept, nothing deleted (integration)      | —                                              |
| A20 | Lease recovery, bounded retry, fencing (integration)                                       | Provider 429/5xx with live client (Phase 2)    |
| A26 | Disconnect stops sync before the next provider call; queued jobs cancelled (integration)   | Token erasure + revocation reporting (Phase 2) |
| A14 | Prompt-injection task note stored and rendered as inert text; no jobs/writes (integ + e2e) | Model-facing injection fixtures (Phase 4)      |
| A28 | Phone-width layout without horizontal scroll; keyboard focus visible (e2e, partial)        | Full accessibility review (Phase 7)            |
| A30 | Log redaction unit tests                                                                   | Full log/export inspection (Phase 7)           |

Not in scope for Phase 1: real Google OAuth for Tasks, token envelopes, Canvas, AI, approvals,
study, external writes, export/delete, deployment.

### Phase 1 verification log (2026-11-04, local container, PostgreSQL 16)

| Check                                                          | Result                                             |
| -------------------------------------------------------------- | -------------------------------------------------- |
| `npm run lint` / `npm run type-check` / `npm run format:check` | pass                                               |
| `npm test` (unit)                                              | 42 passed                                          |
| `npm run test:integration`                                     | 31 passed (local Postgres and compose Postgres)    |
| `npm run test:e2e` (Chromium desktop + Pixel 7 emulation)      | 13 passed                                          |
| `npm run build`                                                | pass                                               |
| `next start` with the mock `.env.local` (NODE_ENV=production)  | refuses to start, lists 7 config issues (intended) |
| README quick start against `infra/compose.yml`                 | migrate, seed, dev, worker, `/api/health` = ok     |

Known gaps carried forward: Google sign-in untested live; in-memory API rate limiter is
per-process; CSP has no script nonce yet; Better Auth returns the session token in the sign-in
JSON body (library default; cookie remains HttpOnly).

---

## Phase 2 — M1: secure read-only Google Tasks

- [ ] Google OAuth authorization-code flow for Tasks (`tasks.readonly`), separate from sign-in
- [ ] Single-use, expiring OAuth state bound to provider + session + host; PKCE; exact redirects
- [ ] Authenticated envelope encryption for tokens (`packages/security`), key ID, rotation path
- [ ] Preserve existing refresh token when a response omits one; serialized refresh per connection
- [ ] Live `GoogleTasksClient` implementing the Phase 1 interface; `updatedMin` overlap window
- [ ] Retry classification for 429/5xx; refresh-once on auth failure; reconnect state
- [ ] Disconnect erases tokens and attempts revocation, reporting the real result
- [ ] Testing-mode refresh-token expiry (≈7 days) surfaced in UI and docs

Gate: real-account smoke test imports expected tasks with no writes; date-only due dates
unchanged across timezones; two-user isolation passes. **Requires:** Google Cloud project,
OAuth client, consent screen, test user (owner action).

## Phase 3 — M2: Canvas context and manual fallback

- [ ] Configured-host Canvas OAuth (if the institution grants a developer key)
- [ ] URL policy: HTTPS only, DNS resolution with private/loopback/link-local/metadata denial
      (IPv4 + IPv6), revalidated on redirects and `Link` pagination; no token forwarding
- [ ] Courses, assignments, own submission metadata, effective due dates; HTML sanitization
- [ ] Task ↔ assignment matching (explicit URL or user-confirmed suggestion only)
- [ ] Manual context entry; "Canvas connection unavailable" state
- [ ] Exact Canvas scope inventory recorded in `PROVIDER_ACCESS.md`

Gate: fixtures pass; live allowed account validates dates/access; no Canvas write calls exist.
If OAuth is blocked, ship manual mode labelled as such.

## Phase 4 — M3: approval engine and assistance artifacts

- [ ] Proposal/approval/execution tables; immutable revisions and canonical hashes
- [ ] State machine (DRAFT → PENDING → APPROVED → EXECUTING → terminal) with conditional updates
- [ ] Approval + job creation in one transaction (outbox); `Idempotency-Key` handling
- [ ] Atomic budget reservations; spend ceiling; usage reconciliation
- [ ] AI adapter (`packages/ai`), schema-constrained output, local validation, one repair max
- [ ] Assistance-mode selector and academic-use rules (unknown/permitted/limited/prohibited)
- [ ] Versioned artifacts, safe rendering, Markdown export

Gate: invalid/expired/cross-user/stale/tampered/replayed approvals cause no generation or side
effects; prompt-injection fixtures grant no authority.

## Phase 5 — M4: study system

- [ ] Study plan request, approved study-pack generation, practice attempts, weak-topic hints
- [ ] DST-aware scheduling; nothing after the test date; unscheduled plan if date unknown

## Phase 6 — M5: approved Google Task completion

- [ ] Incremental write consent; exact diff; separate approval; refetch + version compare;
      GET reconciliation after lost response; `EXTERNAL_WRITES_ENABLED` gate

## Phase 7 — M6: production readiness

- [ ] Deployment (only after owner approval), managed secrets/KMS, backups + restore drill
- [ ] Account export/delete, retention jobs, tombstone reapplication on restore
- [ ] Accessibility and mobile checks, runbooks, provider consent configuration

---

## Change log

| Date       | Change                                         |
| ---------- | ---------------------------------------------- |
| 2026-11-04 | Plan created; Phase 1 implemented (mock mode). |
