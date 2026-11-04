import { describe, expect, it } from "vitest";
import { bucketFor, groupByBucket, syncFreshness, todayInTimeZone } from "@scholar/domain";

const open = (dueDate: string | null) => ({
  status: "needs_action" as const,
  dueDate,
  deleted: false,
});

describe("dashboard buckets", () => {
  const today = "2026-11-04";
  it("classifies relative to the student's local date", () => {
    expect(bucketFor(open("2026-11-03"), today)).toBe("overdue");
    expect(bucketFor(open("2026-11-04"), today)).toBe("today");
    expect(bucketFor(open("2026-11-11"), today)).toBe("upcoming");
    expect(bucketFor(open("2026-11-12"), today)).toBe("later");
    expect(bucketFor(open(null), today)).toBe("no_date");
    expect(bucketFor({ status: "completed", dueDate: "2026-11-01", deleted: false }, today)).toBe(
      "completed",
    );
    expect(bucketFor({ ...open("2026-11-04"), deleted: true }, today)).toBeNull();
  });

  it("puts a Nov 5 task in 'today' for Tokyo and 'upcoming' for New York at the same instant", () => {
    const instant = new Date("2026-11-05T02:00:00.000Z");
    expect(bucketFor(open("2026-11-05"), todayInTimeZone(instant, "Asia/Tokyo"))).toBe("today");
    expect(bucketFor(open("2026-11-05"), todayInTimeZone(instant, "America/New_York"))).toBe(
      "upcoming",
    );
  });

  it("sorts each bucket by due date", () => {
    const g = groupByBucket([open("2026-11-09"), open("2026-11-06"), open("2026-11-08")], today);
    expect(g.upcoming.map((t) => t.dueDate)).toEqual(["2026-11-06", "2026-11-08", "2026-11-09"]);
  });
});

describe("sync freshness", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  it("reports never, fresh, stale and failing", () => {
    expect(
      syncFreshness({ now, intervalSeconds: 900, lastSuccessAt: null, lastErrorAt: null }),
    ).toBe("never");
    expect(
      syncFreshness({
        now,
        intervalSeconds: 900,
        lastSuccessAt: new Date("2026-11-04T11:50:00Z"),
        lastErrorAt: null,
      }),
    ).toBe("fresh");
    expect(
      syncFreshness({
        now,
        intervalSeconds: 900,
        lastSuccessAt: new Date("2026-11-04T11:00:00Z"),
        lastErrorAt: null,
      }),
    ).toBe("stale");
    expect(
      syncFreshness({
        now,
        intervalSeconds: 900,
        lastSuccessAt: new Date("2026-11-04T11:50:00Z"),
        lastErrorAt: new Date("2026-11-04T11:55:00Z"),
      }),
    ).toBe("failing");
  });
});
