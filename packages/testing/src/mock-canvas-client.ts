/**
 * MOCK Canvas client (mock mode + tests): serves synthetic fixtures with pagination and
 * failure injection. Never contacts Canvas. Read-only by construction.
 */
import { ProviderError } from "@scholar/integrations";
import type { CanvasReadClient, Page } from "@scholar/integrations";
import type { MockCanvasDataset } from "./canvas-fixtures.ts";

export class MockCanvasClient implements CanvasReadClient {
  readonly mode = "mock" as const;
  readonly calls: Array<{ op: string; course?: string; page: number }> = [];
  private failures: Array<{
    op: "courses" | "assignments";
    course?: string;
    page: number;
    error: ProviderError;
  }> = [];

  constructor(
    private readonly data: MockCanvasDataset,
    private readonly pageSize = 2,
  ) {}

  injectFailure(f: {
    op: "courses" | "assignments";
    course?: string;
    page: number;
    error: ProviderError;
  }) {
    this.failures.push(f);
  }

  removeAssignment(course: string, assignmentId: number) {
    this.data.assignments[course] = (this.data.assignments[course] ?? []).filter(
      (a) => a.id !== assignmentId,
    );
  }

  private page<T>(
    op: "courses" | "assignments",
    items: T[],
    next: string | undefined,
    course?: string,
  ): Page<T> {
    const page = next ? Number(/^mock:(\d+)$/.exec(next)?.[1] ?? NaN) : 0;
    if (!Number.isInteger(page)) throw new ProviderError("fatal", "invalid_page_token");
    this.calls.push({ op, course, page });
    const f = this.failures.find(
      (x) => x.op === op && x.page === page && (x.course === undefined || x.course === course),
    );
    if (f) throw f.error;
    const start = page * this.pageSize;
    const slice = items.slice(start, start + this.pageSize).map((x) => structuredClone(x));
    return {
      items: slice,
      next: start + this.pageSize < items.length ? `mock:${page + 1}` : undefined,
    };
  }

  async listCourses(next?: string): Promise<Page<unknown>> {
    return this.page("courses", this.data.courses, next);
  }

  async listAssignments(course: string, next?: string): Promise<Page<unknown>> {
    const list = this.data.assignments[course];
    if (!list) throw new ProviderError("not_found", "canvas_not_found");
    return this.page("assignments", list, next, course);
  }
}
