# Scholar AI

An approval-first academic assistant: Google Tasks is the source of academic work, Canvas
(when an institution permits it) supplies assignment context, and every AI action or external
change requires the student's explicit approval.

**Source of truth:** [`SCHOLAR_AI_PLAN.md`](SCHOLAR_AI_PLAN.md).
**Progress and gates:** [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

## Current status — Phase 1 (M0 + first vertical slice), mock mode only

What works today, against **synthetic fixtures**:

- Demo sign-in → timezone → connect the _mock_ Google Tasks adapter → choose lists → background
  worker imports tasks → dashboard (overdue / today / next 7 days / later / no date / completed)
  with sync freshness, manual sync, disconnect (optionally deleting imported data).
- Durable PostgreSQL job queue and worker with scheduling, leases, retries and fencing.
- Strict configuration validation: production refuses mock mode, weak/missing secrets, local
  credentials, and enabling external writes.

What does **not** exist yet (and is not faked): real Google Tasks OAuth, Canvas, AI assistance,
approvals, study tools, task completion, export/deletion, deployment. Live mode returns
"capability unavailable" for these rather than falling back to fixtures. See
[`docs/PROVIDER_ACCESS.md`](docs/PROVIDER_ACCESS.md) for the external prerequisites.

## Quick start (local, mock mode)

Prerequisites: Node.js 22 LTS, Docker (or a local PostgreSQL 16 with a `scholar` role and the
`scholar` + `scholar_test` databases).

```bash
npm ci
cp .env.example .env.local
docker compose -f infra/compose.yml up -d db
npm run db:migrate
npm run db:seed:demo
npm run dev
```

In a second terminal:

```bash
npm run worker:dev
```

Open <http://localhost:3000>, choose a demo student, and enter the demo password. In mock mode
the password is `DEMO_PASSWORD` from `.env.local`, or `scholar-demo-local` when that is empty.
The demo accounts and all coursework are synthetic (`.example` domains).

Health check: `curl http://localhost:3000/api/health` returns `{"status":"ok", ...}` once the
worker heartbeat is fresh.

## Scripts

| Command                                                        | What it does                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `npm run dev` / `npm run worker:dev`                           | Web app (port 3000) / worker, with reload                                   |
| `npm run db:migrate`                                           | Create/apply migrations in development                                      |
| `npm run db:migrate:deploy`                                    | Apply committed migrations (CI/production release job)                      |
| `npm run db:seed:demo`                                         | Idempotent synthetic demo users (mock mode only)                            |
| `npm run lint` · `npm run type-check` · `npm run format:check` | Static checks                                                               |
| `npm test`                                                     | Unit tests                                                                  |
| `npm run test:integration`                                     | PostgreSQL integration tests (uses `TEST_DATABASE_URL`)                     |
| `npm run test:e2e`                                             | Playwright journeys: starts its own web (port 3100) + worker on the test DB |
| `npm run build`                                                | Production build of the web app                                             |

Tests refuse any database whose name does not end in `_test`, never contact a provider, and
never run against your development data. Stop any `next dev` server for `apps/web` before
`npm run test:e2e` (it starts its own). If your Playwright browsers differ from the pinned
version, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` or run `npx playwright install chromium`.

## Layout

```text
apps/web/                 Next.js App Router UI + /api/v1 routes + Better Auth
apps/worker/              Job runner, scheduler, Google Tasks sync handler
packages/config/          Environment loading and validation
packages/db/              Prisma schema, migrations, queue, owner-scoped repositories, seed
packages/domain/          Pure logic: date-only handling, dashboard buckets, sync policy
packages/integrations/    Provider interfaces, response schemas, error classification
packages/security/        Redaction and safe structured logging
packages/testing/         Synthetic fixtures, labelled mock Google Tasks client, test clock
tests/                    unit / integration / e2e suites
infra/                    Local PostgreSQL compose definition
docs/                     Plan tracker, provider access, stack versions
```

## Safety rules enforced in this phase

- The user ID always comes from the server session; other users' IDs behave as missing (404).
  Child rows use composite `(user_id, id)` foreign keys so cross-user links are impossible.
- Cookie-authenticated mutations require a same-origin `Origin` (or `Sec-Fetch-Site`) and JSON
  bodies; there are no mutating GET routes. Per-user rate limits apply.
- Task notes and titles are untrusted content: bounded, stored as text, rendered escaped.
- Logs are structured and redacted (tokens, keys, DB passwords, OAuth codes; academic content
  omitted by default).
- Sign-in requests only OpenID scopes; the Google Tasks grant will be separate (Phase 2).
- Nothing is deployed publicly without the owner's approval.
