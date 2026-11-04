import type { Clock } from "@scholar/domain";

/** Injected clock for deterministic tests. */
export class FixedClock implements Clock {
  private current: number;
  constructor(start: Date | string) {
    this.current = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.current);
  }
  set(value: Date | string): void {
    this.current = new Date(value).getTime();
  }
  advance(ms: number): void {
    this.current += ms;
  }
}
