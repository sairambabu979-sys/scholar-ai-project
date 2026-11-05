import Link from "next/link";
import { redirect } from "next/navigation";
import { listDashboardTasks } from "@scholar/db";
import {
  formatDateOnly,
  effectiveDeadline,
  groupByBucket,
  todayInTimeZone,
  type DashboardBucket,
} from "@scholar/domain";
import { requirePageUser } from "@/lib/session";
import { loadAccountState } from "@/lib/account-state";
import { db } from "@/lib/db";
import { SyncButton } from "@/components/sync-button";
import { SyncStatus } from "@/components/sync-status";
import { TaskItem, type DashboardTask } from "@/components/task-item";

export const dynamic = "force-dynamic";

const SECTIONS: Array<{ key: DashboardBucket; title: string; empty: string }> = [
  { key: "overdue", title: "Overdue", empty: "Nothing overdue." },
  { key: "today", title: "Today", empty: "Nothing due today." },
  { key: "upcoming", title: "Next 7 days", empty: "Nothing due in the next week." },
  { key: "later", title: "Later", empty: "Nothing scheduled further out." },
  { key: "no_date", title: "No due date", empty: "Every open task has a date." },
  { key: "completed", title: "Completed", empty: "No completed tasks yet." },
];

export default async function DashboardPage() {
  const user = await requirePageUser();
  const state = await loadAccountState(user.id);
  if (!state.profile.preference.onboardingCompletedAt && !state.activeGoogle)
    redirect("/onboarding");

  const tz = state.profile.timezone;
  const today = todayInTimeZone(state.now, tz);
  const tasks: DashboardTask[] = (await listDashboardTasks(db(), user.id)).map((t) => {
    const deadline = effectiveDeadline(
      {
        manualDueAt: t.manualContext?.dueAt,
        manualDueDate: t.manualContext?.dueDate,
        canvasDueAt: t.link?.assignment.available ? t.link.assignment.dueAt : null,
        googleDueDate: t.dueDate,
      },
      tz,
    );
    return { ...t, deadline, dueDate: deadline?.date ?? null };
  });
  const groups = groupByBucket(tasks, today);
  const g = state.activeGoogle;

  return (
    <>
      <h1>Dashboard</h1>
      <p className="muted" data-testid="today-line">
        Today is {formatDateOnly(today)} in {tz}.
      </p>
      <section className="card" aria-labelledby="sync-heading">
        <h2 id="sync-heading">Task sync</h2>
        {g ? (
          <div className="stack">
            <SyncStatus
              timezone={tz}
              mode={g.mode}
              status={g.status}
              freshness={g.freshness}
              lastAttemptAt={g.lastAttemptAt}
              lastSuccessAt={g.lastSuccessAt}
              lastErrorCode={g.lastErrorCode}
              activeJobStatus={g.activeJob?.status ?? null}
            />
            {g.status === "active" ? <SyncButton integrationId={g.id} /> : null}
            {g.taskLists.every((l) => !l.selected) ? (
              <p className="notice">
                No task lists selected. <Link href="/onboarding">Choose lists</Link> to import
                tasks.
              </p>
            ) : null}
          </div>
        ) : (
          <p>
            Google Tasks is not connected. <Link href="/onboarding">Set it up</Link>.
          </p>
        )}
      </section>
      <div className="grid">
        {SECTIONS.map((s) => (
          <section
            key={s.key}
            className="card"
            aria-labelledby={`h-${s.key}`}
            data-testid={`bucket-${s.key}`}
          >
            <h2 id={`h-${s.key}`}>
              {s.title} <span className="badge">{groups[s.key].length}</span>
            </h2>
            {groups[s.key].length === 0 ? (
              <p className="muted small">{s.empty}</p>
            ) : (
              <ul className="task-list">
                {groups[s.key].map((t) => (
                  <TaskItem key={t.id} task={t} today={today} timeZone={tz} />
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
      <p className="small muted">
        Open a task to link its Canvas assignment or add details by hand. Assignment help and study
        tools arrive in later phases. Nothing is sent to an AI provider in this build, and Scholar
        AI never changes your Google Tasks or submits Canvas work.
      </p>
    </>
  );
}
