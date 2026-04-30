import type { WorkplaceType } from "@openroles/shared";
import { decodeHTML } from "entities";
import { Parser } from "htmlparser2";

/**
 * Decode HTML entities in a single pass.
 *
 * Per-ATS adapters previously chained `.replace(/&amp;/g, "&")` then
 * `.replace(/&lt;/g, "<")` etc., which double-decodes inputs that
 * legitimately contain `&amp;lt;` (a literal `&lt;` token meant to
 * survive). `entities.decodeHTML` walks the string left-to-right and
 * resolves each `&...;` exactly once, matching browser behavior.
 */
export function decodeHtmlEntities(s: string): string {
  return decodeHTML(s);
}

const SKIP_ELEMENTS = new Set(["script", "style", "noscript", "template"]);

/**
 * Strip HTML and decode entities, preserving only visible text.
 *
 * Uses htmlparser2's streaming tokenizer rather than regex stripping —
 * the regex `/<script\b[^>]*>[\s\S]*?<\/script>/` was technically
 * defeatable (CodeQL `js/bad-tag-filter`, `js/incomplete-multi-character-sanitization`)
 * by malformed shapes like `<script\n>`. The parser handles those
 * correctly because it tracks open/close state instead of greedy matching.
 */
export function plainText(html: string | undefined): string {
  if (!html) return "";
  const out: string[] = [];
  let skipDepth = 0;
  const parser = new Parser({
    onopentag(name) {
      if (SKIP_ELEMENTS.has(name)) skipDepth += 1;
    },
    onclosetag(name) {
      if (SKIP_ELEMENTS.has(name) && skipDepth > 0) skipDepth -= 1;
    },
    ontext(text) {
      if (skipDepth === 0) out.push(text);
    },
  });
  parser.write(html);
  parser.end();
  return decodeHTML(out.join(" ")).replace(/\s+/g, " ").trim();
}

const EXCERPT_MAX = 280;

export function excerpt(body: string): string {
  if (body.length <= EXCERPT_MAX) return body;
  const window = body.slice(0, EXCERPT_MAX);
  const lastSpace = window.lastIndexOf(" ");
  return lastSpace > 0 ? window.slice(0, lastSpace) : window;
}

export interface ParsedLocation {
  readonly text: string;
  readonly country: string | undefined;
  readonly region: string | undefined;
}

const TWO_LETTER_RE = /^[A-Z]{2}$/;

export function splitLocation(text: string): ParsedLocation {
  if (!text) return { text, country: undefined, region: undefined };
  const parts = text.split(",").map((p) => p.trim());
  if (parts.length >= 3) {
    const region = parts[1];
    const country = parts[parts.length - 1];
    return {
      text,
      country: country !== undefined && TWO_LETTER_RE.test(country) ? country : undefined,
      region: region !== undefined && TWO_LETTER_RE.test(region) ? region : undefined,
    };
  }
  if (parts.length === 2) {
    const region = parts[1];
    return {
      text,
      country: undefined,
      region: region !== undefined && TWO_LETTER_RE.test(region) ? region : undefined,
    };
  }
  return { text, country: undefined, region: undefined };
}

const WORKPLACE_PATTERNS: ReadonlyArray<[RegExp, NonNullable<WorkplaceType>]> = [
  [/\bremote\b/i, "remote"],
  [/\bhybrid\b/i, "hybrid"],
  [/\bon[\s-]?site\b/i, "onsite"],
  [/\bin[\s-]?office\b/i, "onsite"],
];

export function normalizeWorkplace(input: string | undefined): WorkplaceType {
  if (!input) return null;
  for (const [re, type] of WORKPLACE_PATTERNS) {
    if (re.test(input)) return type;
  }
  return null;
}
