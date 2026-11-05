import { describe, expect, it } from "vitest";
import { extractCanvasAssignmentRefs, rankCandidates, type MatchAssignment } from "@scholar/domain";

const origin = "https://canvas.school.example";
const A = (over: Partial<MatchAssignment> & { id: string; title: string }): MatchAssignment => ({
  externalId: over.id.replace(/\D/g, ""),
  courseName: "MATH 221: Linear Algebra",
  courseCode: "MATH 221",
  courseExternalId: "2210",
  dueDate: "2026-11-06",
  available: true,
  ...over,
});

describe("Canvas URL extraction", () => {
  it("accepts assignment URLs on approved origins only", () => {
    const text =
      `see ${origin}/courses/1101/assignments/50011 and https://evil.example/courses/1/assignments/2 ` +
      `and ${origin}/courses/1101/files/9 and http://canvas.school.example/courses/1/assignments/3`;
    expect(extractCanvasAssignmentRefs(text, [origin])).toEqual([
      { origin, courseId: "1101", assignmentId: "50011" },
    ]);
    expect(extractCanvasAssignmentRefs(text, [])).toEqual([]);
  });
});

describe("candidate ranking (A10)", () => {
  const assignments = [
    A({ id: "a22107", title: "Problem Set 7", dueDate: "2026-11-06" }),
    A({ id: "a22108", title: "Problem Set 7 Corrections", dueDate: "2026-11-08" }),
    A({ id: "a22106", title: "Problem Set 6", dueDate: "2026-11-01" }),
    A({
      id: "a50011",
      title: "Lab Report: Enzyme Kinetics",
      courseCode: "BIO 110",
      courseExternalId: "1101",
      dueDate: "2026-11-04",
    }),
  ];

  it("returns an exact candidate for a Canvas link in the task", () => {
    const refs = extractCanvasAssignmentRefs(`${origin}/courses/1101/assignments/50011`, [origin]);
    const c = rankCandidates(
      { title: "BIO 110 — Lab report", notes: null, dueDate: "2026-11-04" },
      assignments,
      refs,
    );
    expect(c[0]).toMatchObject({ assignmentId: "a50011", method: "url", confidence: 1 });
  });

  it("offers several ranked alternatives with reasons for an ambiguous title — never just one silent pick", () => {
    const c = rankCandidates(
      { title: "MATH 221 — Problem set 7", notes: null, dueDate: "2026-11-06" },
      assignments,
      [],
    );
    expect(c.length).toBeGreaterThanOrEqual(2);
    expect(c[0]!.assignmentId).toBe("a22107");
    expect(c.map((x) => x.assignmentId)).toContain("a22108");
    expect(
      c.every((x) => x.method === "suggested" && x.confidence < 1 && x.reasons.length > 0),
    ).toBe(true);
    expect(c[0]!.reasons.join(" ")).toMatch(/MATH 221/);
  });

  it("never suggests on course code alone, and rules out conflicting numbers", () => {
    const c = rankCandidates(
      { title: "MATH 221 — Problem set 7", notes: null, dueDate: "2026-11-06" },
      [
        A({ id: "a1", title: "Midterm Exam", dueDate: "2026-11-13" }),
        A({ id: "a2", title: "Problem Set 6", dueDate: "2026-11-01" }),
        A({ id: "a3", title: "Problem Set 7", dueDate: "2026-11-06" }),
      ],
      [],
    );
    expect(c.map((x) => x.assignmentId)).toEqual(["a3"]);
  });

  it("suggests nothing for unrelated personal tasks", () => {
    expect(
      rankCandidates(
        { title: "Buy groceries", notes: null, dueDate: "2026-11-05" },
        assignments,
        [],
      ),
    ).toEqual([]);
  });

  it("skips unavailable assignments for suggestions", () => {
    const c = rankCandidates(
      { title: "MATH 221 — Problem set 7", notes: null, dueDate: "2026-11-06" },
      [A({ id: "a1", title: "Problem Set 7", available: false })],
      [],
    );
    expect(c).toEqual([]);
  });
});
