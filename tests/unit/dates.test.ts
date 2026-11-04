import { describe, expect, it } from "vitest";
import {
  addDays,
  dateOnlyToDbDate,
  dbDateToDateOnly,
  formatDateOnly,
  isValidDateOnly,
  isValidTimeZone,
  parseGoogleDueDate,
  todayInTimeZone,
} from "@scholar/domain";

describe("Google Tasks date-only due values (A04)", () => {
  it("extracts the calendar date without timezone shifting", () => {
    expect(parseGoogleDueDate("2026-11-05T00:00:00.000Z")).toBe("2026-11-05");
    expect(parseGoogleDueDate("2026-11-05T00:00:00Z")).toBe("2026-11-05");
  });

  it("displays November 5 for students in New York and Tokyo alike", () => {
    const due = parseGoogleDueDate("2026-11-05T00:00:00.000Z");
    // Formatting a date-only value never consults the student's timezone.
    expect(formatDateOnly(due)).toBe("Thu, Nov 5, 2026");
    // Round trip through the SQL `date` representation is lossless.
    expect(dbDateToDateOnly(dateOnlyToDbDate(due))).toBe("2026-11-05");
  });

  it("ignores any time/offset part instead of converting it", () => {
    // Even a non-midnight value keeps its literal date part.
    expect(parseGoogleDueDate("2026-11-05T23:30:00-05:00")).toBe("2026-11-05");
  });

  it("rejects malformed or impossible dates", () => {
    expect(() => parseGoogleDueDate("2026-11-05")).toThrow();
    expect(() => parseGoogleDueDate("not a date")).toThrow();
    expect(() => parseGoogleDueDate("2026-02-30T00:00:00.000Z")).toThrow();
    expect(isValidDateOnly("2026-13-01")).toBe(false);
  });
});

describe("student-local today", () => {
  const instant = new Date("2026-11-05T02:00:00.000Z");
  it("differs by timezone at the same instant", () => {
    expect(todayInTimeZone(instant, "America/New_York")).toBe("2026-11-04");
    expect(todayInTimeZone(instant, "Asia/Tokyo")).toBe("2026-11-05");
    expect(todayInTimeZone(instant, "UTC")).toBe("2026-11-05");
  });

  it("handles DST transitions by calendar arithmetic", () => {
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02"); // US DST ends Nov 1, 2026
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("validates IANA timezones", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});
