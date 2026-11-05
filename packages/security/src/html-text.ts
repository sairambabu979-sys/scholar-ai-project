/**
 * Convert untrusted provider HTML (e.g. Canvas assignment descriptions) into a restricted
 * display format: plain text plus a list of https links. Scripts, styles, frames, embedded
 * objects and images are dropped (images become "[image: alt]" without fetching anything);
 * javascript:/data:/other-scheme links are discarded. The result is rendered as escaped text.
 */
import { Parser } from "htmlparser2";

export const MAX_SANITIZED_TEXT = 20_000;
const MAX_LINKS = 50;

const SKIP = new Set([
  "script",
  "style",
  "noscript",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "svg",
  "math",
  "template",
  "head",
  "title",
  "canvas",
  "audio",
  "video",
  "form",
  "select",
  "textarea",
  "button",
]);
const BLOCK = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "blockquote",
  "pre",
  "table",
  "tr",
  "ul",
  "ol",
  "dl",
  "dt",
  "dd",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "figure",
  "figcaption",
  "details",
  "summary",
]);

export interface SanitizedHtml {
  text: string;
  links: string[];
}

function safeLink(href: string, baseOrigin?: string): string | null {
  try {
    const u = baseOrigin ? new URL(href, baseOrigin) : new URL(href);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function htmlToSafeText(html: string, opts: { baseOrigin?: string } = {}): SanitizedHtml {
  let out = "";
  const links: string[] = [];
  let skipDepth = 0;
  let preDepth = 0;
  const anchorStack: Array<{ href: string | null; textStart: number }> = [];

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (skipDepth > 0 || SKIP.has(name)) {
          if (SKIP.has(name)) skipDepth++;
          return;
        }
        if (name === "br") out += "\n";
        else if (name === "li") out += "\n• ";
        else if (name === "td" || name === "th") out += "\t";
        else if (BLOCK.has(name)) out += "\n";
        if (name === "pre") preDepth++;
        if (name === "a")
          anchorStack.push({
            href: attrs.href ? safeLink(attrs.href, opts.baseOrigin) : null,
            textStart: out.length,
          });
        if (name === "img") {
          const alt = (attrs.alt ?? "").trim().slice(0, 200);
          out += alt ? `[image: ${alt}]` : "[image]";
        }
      },
      ontext(text) {
        if (skipDepth > 0) return;
        out += preDepth > 0 ? text : text.replace(/[ \t\r\n\f]+/g, " ");
      },
      onclosetag(name) {
        if (SKIP.has(name)) {
          if (skipDepth > 0) skipDepth--;
          return;
        }
        if (skipDepth > 0) return;
        if (name === "pre" && preDepth > 0) preDepth--;
        if (name === "a") {
          const a = anchorStack.pop();
          if (a?.href) {
            const label = out.slice(a.textStart).trim();
            if (label !== a.href) out += ` (${a.href})`;
            if (links.length < MAX_LINKS && !links.includes(a.href)) links.push(a.href);
          }
        }
        if (BLOCK.has(name) || name === "li") out += "\n";
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html.slice(0, 500_000));
  parser.end();

  const text = out
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .split("\n")
    .map((l) => l.replace(/[ \u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_SANITIZED_TEXT);
  return { text, links };
}
