import type { TaskView } from "@scholar/db";
import { daysBetween, formatDateOnly, type DateOnly } from "@scholar/domain";

function dueLabel(due: DateOnly | null, today: DateOnly): string {
  if (!due) return "No due date";
  const d = daysBetween(today, due);
  const when = formatDateOnly(due);
  if (d === 0) return `Due today (${when})`;
  if (d === 1) return `Due tomorrow (${when})`;
  if (d < 0) return `Overdue by ${-d} day${d === -1 ? "" : "s"} (${when})`;
  return `Due ${when}`;
}

/** Task text is untrusted provider content: rendered as escaped plain text only. */
export function TaskItem({ task, today }: { task: TaskView; today: DateOnly }) {
  return (
    <li data-testid="task-item" data-task-id={task.id}>
      <div className="task-title">
        {task.parentExternalId ? <span className="badge">subtask</span> : null}{" "}
        {task.title || "(untitled)"}
      </div>
      <div className="small muted">
        <span data-testid="due-label">
          {task.status === "completed" ? "Completed" : dueLabel(task.dueDate, today)}
        </span>
        {" · "}
        {task.list.title}
        {task.integration.mode === "mock" ? (
          <>
            {" · "}
            <span className="badge mock">synthetic</span>
          </>
        ) : null}
      </div>
      {task.notes ? <p className="task-notes small">{task.notes}</p> : null}
    </li>
  );
}
