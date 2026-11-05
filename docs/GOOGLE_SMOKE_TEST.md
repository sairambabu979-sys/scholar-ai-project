# Google Tasks Live Smoke Test (milestone M1 gate)

Run this on **your own computer**. The OAuth consent screen needs your browser and your Google
account, and Google only redirects to the `localhost` URIs registered on your OAuth client.
Nothing here is deployed anywhere. Record the result in `docs/IMPLEMENTATION_PLAN.md`.

## 0. Google Cloud (one time)

In the `scholar-ai-dev` project:

1. **Google Tasks API** enabled.
2. **Google Auth Platform → Audience:** External, publishing status **Testing**, your Gmail
   listed under **Test users**.
3. **Data Access:** `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`,
   `https://www.googleapis.com/auth/tasks.readonly` (and **not** `.../auth/tasks`).
4. **Clients → Web application** with exactly these redirect URIs:
   - `http://localhost:3000/api/auth/callback/google`
   - `http://localhost:3000/api/v1/integrations/google/callback`

## 1. Local setup

```bash
git clone https://github.com/sairambabu979-sys/scholar-ai-project.git
cd scholar-ai-project
git checkout claude/phase-2-google-tasks
npm ci
cp .env.example .env.local
docker compose -f infra/compose.yml up -d db
npm run db:migrate
```

Edit `.env.local` (never commit it):

```dotenv
INTEGRATIONS_MODE=live
AUTH_SECRET=<output of: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))">
TOKEN_ENCRYPTION_KEY_BASE64=<output of: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))">
GOOGLE_CLIENT_ID=<from the OAuth client>
GOOGLE_CLIENT_SECRET=<from the OAuth client>
AUTH_ALLOWED_EMAILS=<your gmail>
```

Before you start, create a **disposable task list** in Google Tasks (e.g. "Scholar smoke
test") with: one task due tomorrow, one with no date, one completed task, and one task you will
delete during the test.

Start both processes (two terminals):

```bash
npm run dev
```

```bash
npm run worker:dev
```

## 2. Checks (write down pass/fail for each)

| #   | Step                                                                 | Expected                                                                                                |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | Open http://localhost:3000 → **Continue with Google**                | Google asks only for name, email, profile picture — **no Tasks access**                                 |
| 2   | Setup → **Connect Google Tasks (read-only)**                         | Google's consent lists **"View your tasks"** only (no "create, edit, delete")                           |
| 3   | Approve                                                              | Back on Setup with "Google Tasks connected (read-only)"; your lists appear within ~30 s                 |
| 4   | Select only the disposable list → **Save list selection**            | "Imported"; dashboard shows its tasks, nothing from other lists                                         |
| 5   | Check the task due tomorrow                                          | Dashboard shows tomorrow's date (no off-by-one)                                                         |
| 6   | In Settings change timezone (e.g. to `Asia/Tokyo`), reload dashboard | The task's **due date text does not change**; only "today" may shift                                    |
| 7   | In Google Tasks, delete the throwaway task; press **Sync now**       | It disappears from the dashboard                                                                        |
| 8   | In Google Tasks, confirm nothing was modified by Scholar AI          | No task edited, completed, or created                                                                   |
| 9   | Settings → **Disconnect…** (tick "delete imported tasks") → Confirm  | Notice says access was revoked at Google (or tells you to remove it manually if Google did not confirm) |
| 10  | https://myaccount.google.com/connections                             | Scholar AI's Tasks access is gone (sign-in access may remain)                                           |

If step 3 shows "Google Tasks API is not enabled", enable it in Cloud Console and press Sync.
If sync later says Google rejected the stored permission (often ~7 days in Testing status),
press **Reconnect Google Tasks**.

## 3. Report

Send back: which steps passed/failed and any error codes shown in the UI. **Do not** paste
client secrets, tokens, or screenshots of `.env.local`.
