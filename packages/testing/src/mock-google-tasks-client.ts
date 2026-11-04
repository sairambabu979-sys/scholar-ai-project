/**
 * MOCK Google Tasks client. Serves synthetic fixtures with Google-like semantics (pagination,
 * updatedMin, completed/hidden/deleted visibility) and supports failure injection and
 * mutations for tests. It never contacts Google.
 */
import type {
  GoogleTask,
  GoogleTaskList,
  GoogleTaskListPage,
  GoogleTaskPage,
  GoogleTasksReadClient,
  ListTasksOptions,
} from "@scholar/integrations";
import { ProviderError } from "@scholar/integrations";
import type { Clock } from "@scholar/domain";
import { systemClock } from "@scholar/domain";
import type { MockDataset } from "./google-tasks-fixtures.ts";

export interface InjectedFailure {
  op: "listTaskLists" | "listTasks";
  listId?: string;
  /** Zero-based page index on which to fail. */
  pageIndex: number;
  error: ProviderError;
  /** How many times to fail before succeeding (default: always). */
  times?: number;
}

export interface MockClientOptions {
  taskPageSize?: number;
  listPageSize?: number;
  clock?: Clock;
}

export interface MockCall {
  op: "listTaskLists" | "listTasks";
  listId?: string;
  pageIndex: number;
  updatedMin?: string;
}

const encodeToken = (offset: number) => Buffer.from(`o:${offset}`).toString("base64url");
function decodeToken(token: string | undefined): number {
  if (!token) return 0;
  const raw = Buffer.from(token, "base64url").toString();
  const m = /^o:(\d+)$/.exec(raw);
  if (!m) throw new ProviderError("fatal", "invalid_page_token");
  return Number(m[1]);
}

export class MockGoogleTasksClient implements GoogleTasksReadClient {
  readonly mode = "mock" as const;
  readonly calls: MockCall[] = [];
  private lists: GoogleTaskList[];
  private tasks = new Map<string, GoogleTask[]>();
  private failures: InjectedFailure[] = [];
  private readonly taskPageSize: number;
  private readonly listPageSize: number;
  private readonly clock: Clock;
  private etagCounter = 1;

  constructor(dataset: MockDataset, options: MockClientOptions = {}) {
    this.lists = dataset.lists.map((l) => ({ ...l }));
    for (const l of this.lists) this.tasks.set(l.id, []);
    for (const { listId, task } of dataset.tasks) this.tasks.get(listId)?.push({ ...task });
    this.taskPageSize = options.taskPageSize ?? 5;
    this.listPageSize = options.listPageSize ?? 1;
    this.clock = options.clock ?? systemClock;
  }

  injectFailure(f: InjectedFailure): void {
    this.failures.push({ ...f });
  }

  clearFailures(): void {
    this.failures = [];
  }

  private maybeFail(op: InjectedFailure["op"], pageIndex: number, listId?: string): void {
    const f = this.failures.find(
      (x) =>
        x.op === op && x.pageIndex === pageIndex && (x.listId === undefined || x.listId === listId),
    );
    if (!f) return;
    if (f.times !== undefined) {
      f.times -= 1;
      if (f.times <= 0) this.failures.splice(this.failures.indexOf(f), 1);
    }
    throw f.error;
  }

  async listTaskLists(opts: { pageToken?: string } = {}): Promise<GoogleTaskListPage> {
    const offset = decodeToken(opts.pageToken);
    const pageIndex = Math.floor(offset / this.listPageSize);
    this.calls.push({ op: "listTaskLists", pageIndex });
    this.maybeFail("listTaskLists", pageIndex);
    const items = this.lists.slice(offset, offset + this.listPageSize).map((l) => ({ ...l }));
    const next = offset + this.listPageSize;
    return { items, nextPageToken: next < this.lists.length ? encodeToken(next) : undefined };
  }

  async listTasks(taskListId: string, opts: ListTasksOptions): Promise<GoogleTaskPage> {
    const all = this.tasks.get(taskListId);
    if (!all) throw new ProviderError("not_found", "task_list_not_found");
    const offset = decodeToken(opts.pageToken);
    const pageSize = Math.min(opts.maxResults ?? this.taskPageSize, this.taskPageSize);
    const pageIndex = Math.floor(offset / pageSize);
    this.calls.push({
      op: "listTasks",
      listId: taskListId,
      pageIndex,
      updatedMin: opts.updatedMin,
    });
    this.maybeFail("listTasks", pageIndex, taskListId);
    const min = opts.updatedMin ? Date.parse(opts.updatedMin) : null;
    const visible = all
      .filter((t) => opts.showDeleted || !t.deleted)
      .filter((t) => opts.showHidden || !t.hidden)
      .filter((t) => opts.showCompleted || t.status !== "completed")
      .filter((t) => min === null || Date.parse(t.updated) >= min)
      .sort((a, b) => a.id.localeCompare(b.id));
    const items = visible.slice(offset, offset + pageSize).map((t) => ({ ...t }));
    const next = offset + pageSize;
    return { items, nextPageToken: next < visible.length ? encodeToken(next) : undefined };
  }

  // ---- test mutations (simulate changes made in Google Tasks) ---------------------------

  private touch(task: GoogleTask): void {
    task.updated = this.clock.now().toISOString();
    task.etag = `"mock-etag-${task.id}-v${++this.etagCounter}"`;
  }

  upsertTask(listId: string, task: Partial<GoogleTask> & { id: string }): void {
    const list = this.tasks.get(listId);
    if (!list) throw new Error(`unknown mock list ${listId}`);
    const existing = list.find((t) => t.id === task.id);
    if (existing) {
      Object.assign(existing, task);
      this.touch(existing);
    } else {
      const created: GoogleTask = { status: "needsAction", title: "", updated: "", ...task };
      this.touch(created);
      list.push(created);
    }
  }

  /** Google-style deletion: the task stays visible as a tombstone with showDeleted. */
  deleteTask(listId: string, taskId: string): void {
    const t = this.tasks.get(listId)?.find((x) => x.id === taskId);
    if (!t) throw new Error(`unknown mock task ${taskId}`);
    t.deleted = true;
    this.touch(t);
  }

  /** Remove a task with no tombstone (e.g. purged); only a full scan can notice. */
  purgeTask(listId: string, taskId: string): void {
    const list = this.tasks.get(listId);
    if (!list) return;
    const i = list.findIndex((x) => x.id === taskId);
    if (i >= 0) list.splice(i, 1);
  }

  removeList(listId: string): void {
    this.lists = this.lists.filter((l) => l.id !== listId);
    this.tasks.delete(listId);
  }
}
