import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getProfile, getTaskContext, listAssignmentsForMatching } from "@scholar/db";
import {
  DEADLINE_SOURCE_LABEL,
  effectiveDeadline,
  formatDateOnly,
  formatInstant,
} from "@scholar/domain";
import { requirePageUser } from "@/lib/session";
import { db } from "@/lib/db";
import { linkCandidates } from "@/lib/services";
import { AssignmentPicker, ConfirmLinkButton, UnlinkButton } from "@/components/task-link-actions";
import { ManualContextForm } from "@/components/manual-context-form";

export const dynamic = "force-dynamic";

const SUBMISSION_LABEL: Record<string, string> = {
  unsubmitted: "Not submitted",
  submitted: "Submitted",
  graded: "Graded",
  pending_review: "Pending review",
  unavailable: "Not available — this Canvas connection is not allowed to read submission status",
};

export default async function TaskPage(props: { params: Promise<{ id: string }> }) {
  const user = await requirePageUser();
  const { id } = await props.params;
  if (!z.uuid().safeParse(id).success) notFound();
  const [profile, ctx] = await Promise.all([
    getProfile(db(), user.id),
    getTaskContext(db(), user.id, id),
  ]);
  if (!ctx || !profile) notFound();
  const tz = profile.timezone;
  const a =
    ctx.link?.assignment && ctx.link.assignment.integration.status !== "disconnected"
      ? ctx.link.assignment
      : null;
  const deadline = effectiveDeadline(
    {
      manualDueAt: ctx.manualContext?.dueAt,
      manualDueDate: ctx.manualContext?.dueDate,
      canvasDueAt: a?.available ? a.dueAt : null,
      googleDueDate: ctx.dueDate,
    },
    tz,
  );
  const candidates = a ? null : await linkCandidates(user.id, ctx.id, tz);
  const allAssignments =
    a || !candidates?.canvasConnected ? [] : await listAssignmentsForMatching(db(), user.id);
  const rubric = (a?.rubric as Array<{ description: string; points: number | null }> | null) ?? [];

  return (
    <>
      <p className="small">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1 data-testid="task-title">{ctx.title || "(untitled)"}</h1>

      <section className="card" aria-labelledby="deadline-heading">
        <h2 id="deadline-heading">Deadline</h2>
        {deadline ? (
          <p data-testid="effective-deadline">
            <strong>
              {deadline.instant
                ? formatInstant(deadline.instant, tz)
                : formatDateOnly(deadline.date)}
            </strong>{" "}
            <span className="muted small">(from {DEADLINE_SOURCE_LABEL[deadline.source]})</span>
          </p>
        ) : (
          <p className="muted">No deadline from any source.</p>
        )}
        <ul className="small muted">
          <li>Google Tasks date: {ctx.dueDate ? formatDateOnly(ctx.dueDate) : "none"}</li>
          {a ? <li>Canvas due: {a.dueAt ? formatInstant(a.dueAt, tz) : "none"}</li> : null}
          {ctx.manualContext ? (
            <li>
              Your override:{" "}
              {ctx.manualContext.dueAt
                ? formatInstant(ctx.manualContext.dueAt, tz)
                : ctx.manualContext.dueDate
                  ? formatDateOnly(ctx.manualContext.dueDate)
                  : "none"}
            </li>
          ) : null}
        </ul>
        {deadline && deadline.conflicts.length > 0 ? (
          <p className="notice small" data-testid="deadline-conflict">
            Sources disagree:{" "}
            {deadline.conflicts
              .map((c) => `${DEADLINE_SOURCE_LABEL[c.source]} says ${formatDateOnly(c.date)}`)
              .join("; ")}
            . The {DEADLINE_SOURCE_LABEL[deadline.source]} value is used.
          </p>
        ) : null}
      </section>

      <section className="card" aria-labelledby="canvas-heading">
        <h2 id="canvas-heading">Canvas assignment</h2>
        {a ? (
          <div className="stack" data-testid="assignment-detail">
            <p>
              <strong>{a.title}</strong> · {a.course.courseCode ?? a.course.name}{" "}
              {a.integration.mode === "mock" ? <span className="badge mock">synthetic</span> : null}
              {!a.available ? <span className="badge">no longer available in Canvas</span> : null}
            </p>
            <p className="small">
              Linked by you (
              {ctx.link!.method === "url"
                ? "Canvas link in the task"
                : ctx.link!.method === "suggested"
                  ? "confirmed suggestion"
                  : "chosen from list"}
              ).
              {a.htmlUrl ? (
                <>
                  {" "}
                  <a
                    href={a.htmlUrl}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    data-testid="open-in-canvas"
                  >
                    Open in Canvas
                  </a>
                </>
              ) : null}
            </p>
            {a.isQuiz ? (
              <p className="notice small" data-testid="quiz-notice">
                This is a quiz or test. Scholar AI shows its details for planning only and never
                opens, starts or answers quizzes.
              </p>
            ) : null}
            <ul className="small">
              <li>Due: {a.dueAt ? formatInstant(a.dueAt, tz) : "no due date"}</li>
              {a.unlockAt ? <li>Opens: {formatInstant(a.unlockAt, tz)}</li> : null}
              {a.lockAt ? <li>Closes: {formatInstant(a.lockAt, tz)}</li> : null}
              {a.pointsPossible !== null ? <li>Points: {a.pointsPossible}</li> : null}
              {a.submissionTypes.length > 0 ? (
                <li>Submission: {a.submissionTypes.join(", ").replaceAll("_", " ")}</li>
              ) : null}
              <li data-testid="submission-status">
                Your submission:{" "}
                {a.submission
                  ? (SUBMISSION_LABEL[a.submission.status] ?? a.submission.status)
                  : "unknown"}
                {a.submission?.missing ? " · marked missing" : ""}
                {a.submission?.late ? " · late" : ""}
              </li>
            </ul>
            {a.descriptionText ? (
              <div>
                <h3 className="small">Description (from Canvas, shown as plain text)</h3>
                <p className="task-notes small" data-testid="assignment-description">
                  {a.descriptionText}
                </p>
              </div>
            ) : null}
            {rubric.length > 0 ? (
              <div>
                <h3 className="small">Rubric</h3>
                <ul className="small">
                  {rubric.map((r, i) => (
                    <li key={i}>
                      {r.description}
                      {r.points !== null ? ` — ${r.points} pts` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <UnlinkButton taskId={ctx.id} />
          </div>
        ) : !candidates?.canvasConnected ? (
          <p className="muted small" data-testid="canvas-not-connected">
            Canvas is not connected, so there are no assignments to link. Add the details yourself
            below.
          </p>
        ) : (
          <div className="stack">
            {candidates.candidates.length === 0 ? (
              <p className="muted small">No likely matches in your Canvas courses.</p>
            ) : (
              <ul className="task-list" data-testid="link-candidates">
                {candidates.candidates.map((c) => (
                  <li key={c.assignmentId} data-testid="link-candidate">
                    <div>
                      <strong>{c.assignment.title}</strong> ·{" "}
                      {c.assignment.courseCode ?? c.assignment.courseName}
                      {c.assignment.dueAt
                        ? ` · due ${formatInstant(new Date(c.assignment.dueAt), tz)}`
                        : ""}
                    </div>
                    <div className="small muted">
                      {c.method === "url"
                        ? "Exact match"
                        : `Suggestion (${Math.round(c.confidence * 100)}%)`}
                      : {c.reasons.join("; ")}
                    </div>
                    <ConfirmLinkButton
                      taskId={ctx.id}
                      assignmentId={c.assignmentId}
                      method={c.method}
                      confidence={c.confidence}
                      reasons={c.reasons}
                      expectedTaskVersion={ctx.versionHash}
                      label="Confirm this assignment"
                    />
                  </li>
                ))}
              </ul>
            )}
            <p className="small muted">Nothing is linked until you confirm one.</p>
            <AssignmentPicker
              taskId={ctx.id}
              expectedTaskVersion={ctx.versionHash}
              options={allAssignments
                .filter((x) => x.available)
                .map((x) => ({
                  id: x.id,
                  label: `${x.course.courseCode ?? x.course.name} — ${x.title}`,
                }))}
            />
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="manual-heading">
        <h2 id="manual-heading">Your assignment details</h2>
        <p className="small muted">
          Use this when the assignment is not in Canvas or Canvas is unavailable. A due date here
          overrides other sources.
        </p>
        <ManualContextForm
          taskId={ctx.id}
          defaultTitle={ctx.title}
          existing={
            ctx.manualContext
              ? {
                  title: ctx.manualContext.title,
                  requirements: ctx.manualContext.requirements,
                  sources: ctx.manualContext.sources,
                  dueDate: ctx.manualContext.dueDate,
                  version: ctx.manualContext.version,
                }
              : null
          }
        />
        {ctx.manualContext && ctx.manualContext.sources.length > 0 ? (
          <ul className="small" data-testid="manual-sources">
            {ctx.manualContext.sources.map((s) => (
              <li key={s}>
                <a href={s} target="_blank" rel="noopener noreferrer nofollow">
                  {s}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="card" aria-labelledby="task-heading">
        <h2 id="task-heading">In Google Tasks</h2>
        <p className="small muted">
          List: {ctx.taskList.title} · {ctx.status === "completed" ? "completed" : "open"}
          {ctx.integration.mode === "mock" ? " · synthetic" : ""}
        </p>
        {ctx.notes ? (
          <p className="task-notes small">{ctx.notes}</p>
        ) : (
          <p className="muted small">No notes.</p>
        )}
      </section>
    </>
  );
}
