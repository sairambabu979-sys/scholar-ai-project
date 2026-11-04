import { describe, expect, it } from "vitest";
import {
  chooseSyncMode,
  disappearedIds,
  FULL_RECONCILE_INTERVAL_MS,
  incrementalUpdatedMin,
  INCREMENTAL_OVERLAP_MS,
  isScheduledSyncDue,
  nextWatermark,
  retryDelayMs,
} from "@scholar/domain";

describe("sync mode", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  it("starts with a full scan and reconciles periodically", () => {
    expect(chooseSyncMode(null, now)).toBe("full");
    const recent = { watermark: now, lastFullReconciliationAt: new Date(now.getTime() - 60_000) };
    expect(chooseSyncMode(recent, now)).toBe("incremental");
    const old = {
      watermark: now,
      lastFullReconciliationAt: new Date(now.getTime() - FULL_RECONCILE_INTERVAL_MS),
    };
    expect(chooseSyncMode(old, now)).toBe("full");
  });

  it("reads incrementally with an overlap window", () => {
    expect(incrementalUpdatedMin(now).getTime()).toBe(now.getTime() - INCREMENTAL_OVERLAP_MS);
  });
});

describe("disappearance inference", () => {
  const local = ["a", "b", "c"];
  const fetched = new Set(["a", "c"]);
  it("only a complete full scan can mark records gone", () => {
    expect(disappearedIds(local, fetched, { mode: "full", complete: true })).toEqual(["b"]);
    expect(disappearedIds(local, fetched, { mode: "full", complete: false })).toEqual([]);
    expect(disappearedIds(local, fetched, { mode: "incremental", complete: true })).toEqual([]);
  });
});

describe("watermark", () => {
  it("never moves backwards", () => {
    const prev = new Date("2026-11-04T10:00:00Z");
    expect(nextWatermark(prev, ["2026-11-04T09:00:00Z"])?.toISOString()).toBe(prev.toISOString());
    expect(nextWatermark(prev, ["2026-11-04T11:00:00Z"])?.toISOString()).toBe(
      "2026-11-04T11:00:00.000Z",
    );
    expect(nextWatermark(null, [])).toBeNull();
  });
});

describe("scheduling and retry", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  it("is due after the interval, with bounded jitter", () => {
    expect(
      isScheduledSyncDue({ now, lastAttemptAt: null, intervalSeconds: 900, jitterFraction: 0 }),
    ).toBe(true);
    const at = (s: number) => new Date(now.getTime() - s * 1000);
    expect(
      isScheduledSyncDue({ now, lastAttemptAt: at(800), intervalSeconds: 900, jitterFraction: 0 }),
    ).toBe(false);
    expect(
      isScheduledSyncDue({ now, lastAttemptAt: at(900), intervalSeconds: 900, jitterFraction: 0 }),
    ).toBe(true);
    expect(
      isScheduledSyncDue({ now, lastAttemptAt: at(950), intervalSeconds: 900, jitterFraction: 1 }),
    ).toBe(false);
  });

  it("backs off exponentially with full jitter and a ceiling", () => {
    expect(retryDelayMs(1, { random: () => 0.999 })).toBeLessThan(5_000);
    expect(retryDelayMs(3, { random: () => 0.999 })).toBeLessThan(20_000);
    expect(retryDelayMs(50, { random: () => 0.999 })).toBeLessThanOrEqual(600_000);
    expect(retryDelayMs(1, { random: () => 0, retryAfterMs: 30_000 })).toBe(30_000);
  });
});
