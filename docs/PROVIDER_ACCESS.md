# Provider Access Checklist and Scope Inventory

Status as of 2026-11-05. Update this file whenever a gate changes. Mock mode passing is **not**
evidence that any provider granted access.

## Gate status

| #   | Prerequisite (SCHOLAR_AI_PLAN.md §3)                                    | Status                                                                                                                                                                                                   | Owner action needed                                                                                                          |
| --- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | Google Cloud project, Tasks API enabled, OAuth consent + redirects      | **In progress (owner)** — project `scholar-ai-dev` and its OAuth configuration created 2026-11-04 (seen in a screenshot); Tasks API enablement, test user, scopes and the OAuth client not yet confirmed | Finish §0 of [GOOGLE_SMOKE_TEST.md](GOOGLE_SMOKE_TEST.md), then run the smoke test                                           |
| 2   | Canvas developer key, institution base URL, scoped endpoints, redirects | **Not established** — Canvas availability unknown                                                                                                                                                        | Ask the institution's Canvas administrator whether they will issue a scoped developer key. If not, Phase 3 ships manual mode |
| 3   | AI API credential, model ID, spend limits                               | **Not started**                                                                                                                                                                                          | Provision an Anthropic API key for the app (a Claude Code subscription is not one)                                           |
| 4   | Node.js LTS, PostgreSQL, locked package versions                        | **Done**                                                                                                                                                                                                 | — (see [STACK.md](STACK.md))                                                                                                 |
| 5   | Production URL, host, secret store, encrypted backups, worker model     | **Not started**                                                                                                                                                                                          | Decide in Phase 7; nothing is deployed without owner approval                                                                |

**Canvas availability (recorded explicitly, per the M0 gate):** _not established_. The
institution hostname is unknown (`yourschool.instructure.com` in the original conversation was
an example). No Canvas code path exists yet; the UI states "Canvas connection unavailable".
A student being able to log in to Canvas does not mean the institution permits third-party
applications.

## Scope inventory

### Google — application sign-in (implemented, untested against a live Google project)

| Scope     | Why                                                  |
| --------- | ---------------------------------------------------- |
| `openid`  | Identity                                             |
| `email`   | Account email; matched against `AUTH_ALLOWED_EMAILS` |
| `profile` | Display name                                         |

Redirect URI: `{APP_URL}/api/auth/callback/google`. No Tasks scope is ever requested at sign-in.

### Google — Tasks integration (implemented in Phase 2; live gate pending)

| Scope                                            | When                                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `openid`                                         | With the Tasks grant, to identify which Google account was connected (`sub`)       |
| `https://www.googleapis.com/auth/tasks.readonly` | On "Connect Google Tasks" (separate grant, `include_granted_scopes=false`)         |
| `https://www.googleapis.com/auth/tasks`          | **Not requested.** Only on explicit upgrade for approved task completion (Phase 6) |

Redirect URI: `{APP_URL}/api/v1/integrations/google/callback`. Offline access is required for
background sync. **Known constraint:** for External apps in Testing status, refresh tokens for
these scopes generally expire after ~7 days, so background sync would require reconnecting
weekly until the app is verified/published. Recheck Google's current rules before relying on
this.

### Canvas (implemented in Phase 3; live gate blocked on the institution)

Requested only when `CANVAS_ENABLED=true` with an approved `CANVAS_BASE_URL`. Defaults (override
with `CANVAS_SCOPES` to match the developer key; config refuses anything but `url:GET|/api/v1/…`):

| Scope                                             | Used for                                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `url:GET\|/api/v1/courses`                        | The student's active courses (`enrollment_type=student`)                                                                     |
| `url:GET\|/api/v1/courses/:course_id/assignments` | Assignments with the student's effective dates; `include[]=submission` for their own submission state when the key allows it |

Never requested or called: any POST/PUT/DELETE API, submissions/quiz endpoints, grades,
messaging, `include[]=read_status`. Token revocation uses `DELETE /login/oauth2/token` (OAuth
endpoint, not an API scope). Redirect URI: `{APP_URL}/api/v1/integrations/canvas/callback`.

What to ask the institution for: a developer key (API key, not LTI) with **Enforce scopes** on,
the two GET scopes above, "Allow include parameters" if they will permit `include[]=submission`,
and the redirect URI above. If they decline, the product runs in manual mode.

## What mock mode is

`INTEGRATIONS_MODE=mock` serves synthetic fixtures from `packages/testing`. Every page shows a
"Mock mode" banner, mock integrations are stored with `mode = mock`, and the worker refuses to
serve fixtures to a live integration or in live mode. Production startup refuses mock mode.
