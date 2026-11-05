import Link from "next/link";
import type { TaskView } from "@scholar/db";
import {
  DEADLINE_SOURCE_LABEL,
  daysBetween,
  formatDateOnly,
  formatInstant,
  type DateOnly,
  type EffectiveDeadline,
} from "@scholar/domain";

export type DashboardTask = TaskView & {
  deadline: EffectiveDeadline | null;
  dueDate: DateOnly | null;
};

function dueLabel(deadline: EffectiveDeadline | null, today: DateOnly, tz: string): string {
  if (!deadline) return "No due date";
  const d = daysBetween(today, deadline.date);
  const when = deadline.instant
    ? formatInstant(deadline.instant, tz)
    : formatDateOnly(deadline.date);
  if (d === 0) return `Due today (${when})`;
  if (d === 1) return `Due tomorrow (${when})`;
  if (d < 0) return `Overdue by ${-d} day${d === -1 ? "" : "s"} (${when})`;
  return `Due ${when}`;
}

/** Task text is untrusted provider content: rendered as escaped plain text only. */
export function TaskItem({
  task,
  today,
  timeZone,
}: {
  task: DashboardTask;
  today: DateOnly;
  timeZone: string;
}) {
  const d = task.deadline;
  return (
    <li data-testid="task-item" data-task-id={task.id}>
      <div className="task-title">
        {task.parentExternalId ? <span className="badge">subtask</span> : null}{" "}
        <Link href={`/tasks/${task.id}`}>{task.title || "(untitled)"}</Link>
      </div>
      <div className="small muted">
        <span data-testid="due-label">
          {task.status === "completed" ? "Completed" : dueLabel(d, today, timeZone)}
        </span>
        {d && task.status !== "completed" && (task.link || task.manualContext) ? (
          <span data-testid="due-source"> · from {DEADLINE_SOURCE_LABEL[d.source]}</span>
        ) : null}
        {" · "}
        {task.list.title}
        {task.integration.mode === "mock" ? (
          <>
            {" · "}
            <span className="badge mock">synthetic</span>
          </>
        ) : null}
      </div>
      {task.link ? (
        <div className="small" data-testid="linked-assignment">
          <span className="badge">Canvas</span>{" "}
          {task.link.assignment.courseCode ?? task.link.assignment.courseName}:{" "}
          {task.link.assignment.title}
          {!task.link.assignment.available ? (
            <span className="badge"> no longer available</span>
          ) : null}
        </div>
      ) : task.manualContext ? (
        <div className="small" data-testid="manual-context-badge">
          <span className="badge">Your details</span> {task.manualContext.title}
        </div>
      ) : null}
      {d && d.conflicts.length > 0 && task.status !== "completed" ? (
        <div className="small muted" data-testid="due-conflict">
          {d.conflicts
            .map((c) => `${DEADLINE_SOURCE_LABEL[c.source]} says ${formatDateOnly(c.date)}`)
            .join("; ")}
        </div>
      ) : null}
      {task.notes ? <p className="task-notes small">{task.notes}</p> : null}
    </li>
  );
}
