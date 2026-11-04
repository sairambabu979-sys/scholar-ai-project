import { describe, expect, it } from "vitest";
import { ProviderError } from "@scholar/integrations";
import {
  buildMockGoogleTasksDataset,
  MOCK_LIST_COURSEWORK,
  MockGoogleTasksClient,
} from "@scholar/testing";

const all = { showCompleted: true, showHidden: true, showDeleted: true };

async function collect(client: MockGoogleTasksClient, opts = all) {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await client.listTasks(MOCK_LIST_COURSEWORK, { ...opts, pageToken });
    ids.push(...page.items.map((t) => t.id));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return ids;
}

describe("mock Google Tasks client", () => {
  it("paginates every item exactly once", async () => {
    const client = new MockGoogleTasksClient(buildMockGoogleTasksDataset("2026-11-04"), {
      taskPageSize: 5,
    });
    const ids = await collect(client);
    expect(ids.length).toBe(12);
    expect(new Set(ids).size).toBe(12);
    expect(client.calls.filter((c) => c.op === "listTasks").length).toBe(3);
  });

  it("honours completed/hidden/deleted visibility like Google", async () => {
    const client = new MockGoogleTasksClient(buildMockGoogleTasksDataset("2026-11-04"));
    const visible = await collect(client, {
      showCompleted: true,
      showHidden: false,
      showDeleted: false,
    });
    expect(visible).not.toContain("mock-task-009"); // hidden
    expect(visible).not.toContain("mock-task-010"); // deleted
    const open = await collect(client, {
      showCompleted: false,
      showHidden: false,
      showDeleted: false,
    });
    expect(open).not.toContain("mock-task-008"); // completed
  });

  it("injects failures on a specific page", async () => {
    const client = new MockGoogleTasksClient(buildMockGoogleTasksDataset("2026-11-04"), {
      taskPageSize: 5,
    });
    client.injectFailure({
      op: "listTasks",
      pageIndex: 1,
      error: new ProviderError("retryable", "http_503"),
      times: 1,
    });
    await expect(collect(client)).rejects.toMatchObject({ code: "http_503" });
    expect((await collect(client)).length).toBe(12);
  });

  it("uses synthetic data only (reserved .example domains)", () => {
    const ds = buildMockGoogleTasksDataset("2026-11-04");
    for (const { task } of ds.tasks) {
      for (const url of (task.notes ?? "").match(/https?:\/\/[^\s]+/g) ?? []) {
        expect(new URL(url).hostname.endsWith(".example")).toBe(true);
      }
    }
  });
});
