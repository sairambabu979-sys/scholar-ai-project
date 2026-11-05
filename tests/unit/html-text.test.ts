import { describe, expect, it } from "vitest";
import { htmlToSafeText, MAX_SANITIZED_TEXT } from "@scholar/security";

describe("Canvas HTML → restricted text (A15)", () => {
  const origin = "https://canvas.school.example";

  it("drops scripts, styles, frames, forms and unsafe links; keeps readable text", () => {
    const r = htmlToSafeText(
      `<p>Write the <b>lab report</b>.</p><script>steal(document.cookie)</script><style>p{}</style>` +
        `<iframe src="https://evil.example"></iframe><form><input name="pw"></form>` +
        `<a href="javascript:alert(1)">bad</a> <a href="data:text/html,x">data</a> <a href="http://insecure.example">http</a>` +
        `<p onclick="evil()">safe text</p>`,
      { baseOrigin: origin },
    );
    expect(r.text).toContain("Write the lab report.");
    expect(r.text).toContain("safe text");
    for (const bad of [
      "steal",
      "cookie",
      "p{}",
      "evil.example",
      "javascript",
      "data:",
      "insecure.example",
      "onclick",
    ]) {
      expect(r.text).not.toContain(bad);
    }
    expect(r.links).toEqual([]);
  });

  it("never fetches images; keeps alt text only", () => {
    const r = htmlToSafeText(
      `<img src="https://tracker.example/p.png" alt="Michaelis–Menten plot">`,
    );
    expect(r.text).toBe("[image: Michaelis–Menten plot]");
    expect(JSON.stringify(r)).not.toContain("tracker.example");
  });

  it("resolves relative links against the Canvas origin and keeps only https", () => {
    const r = htmlToSafeText(`<a href="/courses/1/files/2">data sheet</a>`, { baseOrigin: origin });
    expect(r.links).toEqual(["https://canvas.school.example/courses/1/files/2"]);
    expect(r.text).toBe("data sheet (https://canvas.school.example/courses/1/files/2)");
  });

  it("decodes entities as text (no markup can survive) and preserves list structure", () => {
    const r = htmlToSafeText(`<ul><li>&lt;script&gt;x&lt;/script&gt;</li><li>B &amp; C</li></ul>`);
    expect(r.text).toBe("• <script>x</script>\n\n• B & C");
  });

  it("bounds the output", () => {
    expect(htmlToSafeText(`<p>${"x".repeat(50_000)}</p>`).text.length).toBe(MAX_SANITIZED_TEXT);
  });
});
