/**
 * Task ↔ Canvas assignment matching (SCHOLAR_AI_PLAN.md §4.3). Pure and deterministic.
 *
 *  - An approved-host Canvas assignment URL in the task identifies a candidate exactly.
 *  - Otherwise candidates are ranked locally from course code, title overlap and due-date
 *    proximity, each with human-readable reasons.
 *  - Nothing here links anything: every candidate needs the student's confirmation.
 */
import { daysBetween, type DateOnly } from "./dates.ts";

export interface CanvasAssignmentRef {
  origin: string;
  courseId: string;
  assignmentId: string;
}

const ASSIGNMENT_PATH = /^\/courses\/(\d{1,20})\/assignments\/(\d{1,20})\/?$/;

/** Canvas assignment URLs in free text, restricted to the approved Canvas origins. */
export function extractCanvasAssignmentRefs(
  text: string | null | undefined,
  approvedOrigins: readonly string[],
): CanvasAssignmentRef[] {
  if (!text || approvedOrigins.length === 0) return [];
  const out: CanvasAssignmentRef[] = [];
  for (const match of text.slice(0, 20_000).matchAll(/https:\/\/[^\s<>"')\]]+/g)) {
    let u: URL;
    try {
      u = new URL(match[0]);
    } catch {
      continue;
    }
    if (!approvedOrigins.includes(u.origin)) continue;
    const m = ASSIGNMENT_PATH.exec(u.pathname);
    if (!m) continue;
    const ref = { origin: u.origin, courseId: m[1]!, assignmentId: m[2]! };
    if (!out.some((r) => r.assignmentId === ref.assignmentId && r.origin === ref.origin))
      out.push(ref);
  }
  return out;
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "for",
  "in",
  "on",
  "at",
  "with",
  "due",
  "hw",
  "assignment",
  "task",
]);

export function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(" ")
      // Keep single digits: "Problem set 7" vs "Problem set 6" must not look identical.
      .filter((t) => (t.length > 1 || /^\d$/.test(t)) && !STOPWORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** "BIO 110", "BIO110", "bio-110" → "bio110" */
const compactCode = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface MatchTask {
  title: string;
  notes: string | null;
  dueDate: DateOnly | null;
}

export interface MatchAssignment {
  id: string;
  externalId: string;
  title: string;
  courseName: string;
  courseCode: string | null;
  courseExternalId: string;
  /** Due date in the student's timezone, if any. */
  dueDate: DateOnly | null;
  available: boolean;
}

export interface Candidate {
  assignmentId: string;
  method: "url" | "suggested";
  confidence: number;
  reasons: string[];
}

export const MIN_SUGGESTION_CONFIDENCE = 0.25;

export function rankCandidates(
  task: MatchTask,
  assignments: readonly MatchAssignment[],
  refs: readonly CanvasAssignmentRef[],
  limit = 5,
): Candidate[] {
  const exact: Candidate[] = [];
  for (const ref of refs) {
    const a = assignments.find(
      (x) => x.externalId === ref.assignmentId && x.courseExternalId === ref.courseId,
    );
    if (a)
      exact.push({
        assignmentId: a.id,
        method: "url",
        confidence: 1,
        reasons: ["Canvas link to this assignment is in the task"],
      });
  }

  const taskTokens = tokens(task.title);
  const taskCompact = compactCode(task.title);
  const numbersIn = (set: Set<string>) => new Set([...set].filter((t) => /^\d+$/.test(t)));
  const scored: Candidate[] = [];
  for (const a of assignments) {
    if (!a.available || exact.some((e) => e.assignmentId === a.id)) continue;
    const reasons: string[] = [];
    let score = 0;
    const assignmentTokens = tokens(a.title);
    // Conflicting numbers ("Problem set 7" vs "Problem Set 6") rule a candidate out.
    const taskNumbers = numbersIn(taskTokens);
    const assignmentNumbers = numbersIn(assignmentTokens);
    if (
      taskNumbers.size > 0 &&
      assignmentNumbers.size > 0 &&
      ![...assignmentNumbers].some((n) => taskNumbers.has(n))
    ) {
      continue;
    }
    let evidence = false;
    if (
      a.courseCode &&
      compactCode(a.courseCode).length >= 4 &&
      taskCompact.includes(compactCode(a.courseCode))
    ) {
      score += 0.35;
      reasons.push(`Course code ${a.courseCode} appears in the task title`);
    }
    const overlap = jaccard(taskTokens, assignmentTokens);
    if (overlap > 0) {
      score += 0.45 * overlap;
      if (overlap >= 0.2) {
        reasons.push(`Title words overlap (${Math.round(overlap * 100)}%)`);
        evidence = true;
      }
    }
    if (task.dueDate && a.dueDate) {
      const d = Math.abs(daysBetween(task.dueDate, a.dueDate));
      if (d === 0) {
        score += 0.2;
        reasons.push("Same due date");
        evidence = true;
      } else if (d <= 2) {
        score += 0.1;
        reasons.push(`Due dates ${d} day${d === 1 ? "" : "s"} apart`);
        evidence = true;
      }
    }
    // A shared course code alone is a boost, never sufficient evidence by itself.
    if (score >= MIN_SUGGESTION_CONFIDENCE && evidence) {
      scored.push({
        assignmentId: a.id,
        method: "suggested",
        confidence: Math.min(0.95, Math.round(score * 100) / 100),
        reasons,
      });
    }
  }
  scored.sort((x, y) => y.confidence - x.confidence);
  return [...exact, ...scored].slice(0, limit);
}
