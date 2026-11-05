import { describe, expect, it } from "vitest";
import { LiveCanvasClient, parseNextLink } from "@scholar/integrations";

const origin = "https://canvas.school.example";
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function client(responses: Response[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let v = 1;
  let refreshed = 0;
  const c = new LiveCanvasClient({
    origin,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const r = responses.shift();
      if (!r) throw new Error("no response queued");
      return r;
    },
    tokens: {
      get: async () => ({ accessToken: `t${v}`, tokenVersion: v }),
      refreshAfterRejection: async () => {
        refreshed++;
        v++;
        return { accessToken: `t${v}`, tokenVersion: v };
      },
    },
  });
  return { c, calls, refreshed: () => refreshed };
}

describe("live Canvas client", () => {
  it("requests the student's courses and own submissions only, with a bearer token and no redirects", async () => {
    const { c, calls } = client([json(200, []), json(200, [])]);
    await c.listCourses();
    await c.listAssignments("1101");
    const courses = new URL(calls[0]!.url);
    expect(courses.origin + courses.pathname).toBe(`${origin}/api/v1/courses`);
    expect(courses.searchParams.get("enrollment_type")).toBe("student");
    const asg = new URL(calls[1]!.url);
    expect(asg.pathname).toBe("/api/v1/courses/1101/assignments");
    expect(asg.searchParams.getAll("include[]")).toEqual(["submission"]);
    expect(asg.search).not.toContain("read_status");
    expect(calls.every((x) => x.init.redirect === "error" && x.init.method === "GET")).toBe(true);
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer t1");
  });

  it("follows same-origin Link pagination and refuses foreign next links (A16)", async () => {
    const next = `${origin}/api/v1/courses?page=2&per_page=50`;
    const ok = client([
      json(200, [{ id: 1 }], { link: `<${next}>; rel="next"` }),
      json(200, [{ id: 2 }]),
    ]);
    const p1 = await ok.c.listCourses();
    expect(p1.next).toBe(next);
    expect((await ok.c.listCourses(p1.next)).items).toEqual([{ id: 2 }]);

    const evil = client([
      json(200, [{ id: 1 }], { link: `<https://evil.example/api/v1/courses?page=2>; rel="next"` }),
    ]);
    await expect(evil.c.listCourses()).rejects.toMatchObject({
      code: "canvas_foreign_url_refused",
    });
    // A forged continuation is refused before any request carries the token.
    await expect(
      evil.c.listCourses("https://169.254.169.254/latest/meta-data"),
    ).rejects.toMatchObject({ code: "canvas_foreign_url_refused" });
    expect(evil.calls).toHaveLength(1);
  });

  it("refreshes once on 401, then gives up with an auth error", async () => {
    const a = client([json(401, {}), json(200, [])]);
    await a.c.listCourses();
    expect(a.refreshed()).toBe(1);
    const b = client([json(401, {}), json(401, {})]);
    await expect(b.c.listCourses()).rejects.toMatchObject({ kind: "auth" });
    expect(b.refreshed()).toBe(1);
  });

  it("classifies throttling, permission and server errors", async () => {
    const t = client([new Response("403 Forbidden (Rate Limit Exceeded)", { status: 403 })]);
    await expect(t.c.listCourses()).rejects.toMatchObject({
      kind: "retryable",
      code: "canvas_throttled",
    });
    const f = client([json(403, { errors: [{ message: "insufficient scopes" }] })]);
    await expect(f.c.listCourses()).rejects.toMatchObject({
      kind: "unavailable",
      code: "canvas_forbidden_scope_or_permission",
    });
    const s = client([json(503, {})]);
    await expect(s.c.listCourses()).rejects.toMatchObject({ kind: "retryable" });
    const r = client([
      new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
    ]);
    await expect(r.c.listCourses()).rejects.toMatchObject({ kind: "fatal" });
  });

  it("rejects non-numeric course ids before building a URL", async () => {
    const { c, calls } = client([]);
    await expect(c.listAssignments("../users/self")).rejects.toMatchObject({
      code: "canvas_invalid_course_id",
    });
    expect(calls).toHaveLength(0);
  });

  it("parses RFC 8288 Link headers", () => {
    expect(
      parseNextLink(`<https://x/a?page=2>; rel="next", <https://x/a?page=9>; rel="last"`),
    ).toBe("https://x/a?page=2");
    expect(parseNextLink(`<https://x/a?page=1>; rel="current"`)).toBeUndefined();
    expect(parseNextLink(null)).toBeUndefined();
  });
});
