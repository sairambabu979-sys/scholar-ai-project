import { describe, expect, it } from "vitest";
import { effectiveDeadline } from "@scholar/domain";

describe("effective deadline precedence with provenance (A09)", () => {
  const canvas = new Date("2026-11-10T04:59:00Z"); // Nov 9, 23:59 in New York

  it("override > Canvas instant > Google date, and reports disagreements", () => {
    expect(effectiveDeadline({ googleDueDate: "2026-11-09" }, "America/New_York")).toMatchObject({
      source: "google",
      date: "2026-11-09",
      instant: null,
    });
    const c = effectiveDeadline(
      { canvasDueAt: canvas, googleDueDate: "2026-11-08" },
      "America/New_York",
    )!;
    expect(c).toMatchObject({ source: "canvas", date: "2026-11-09" });
    expect(c.conflicts).toEqual([{ source: "google", date: "2026-11-08" }]);
    const m = effectiveDeadline(
      { manualDueDate: "2026-11-12", canvasDueAt: canvas, googleDueDate: "2026-11-09" },
      "America/New_York",
    )!;
    expect(m.source).toBe("manual");
    expect(m.conflicts.map((x) => x.source)).toEqual(["canvas", "google"]);
  });

  it("places a Canvas instant on the student's local date", () => {
    expect(effectiveDeadline({ canvasDueAt: canvas }, "America/New_York")!.date).toBe("2026-11-09");
    expect(effectiveDeadline({ canvasDueAt: canvas }, "Asia/Tokyo")!.date).toBe("2026-11-10");
  });

  it("returns null when no source has a date", () => {
    expect(effectiveDeadline({}, "UTC")).toBeNull();
  });
});
