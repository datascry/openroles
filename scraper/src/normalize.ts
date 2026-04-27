import type { WorkplaceType } from "@openroles/shared";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (_match, name) => {
    const n = String(name);
    if (n.startsWith("#x")) {
      const code = Number.parseInt(n.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _match;
    }
    if (n.startsWith("#")) {
      const code = Number.parseInt(n.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _match;
    }
    return NAMED_ENTITIES[n.toLowerCase()] ?? _match;
  });
}

export function plainText(html: string | undefined): string {
  if (!html) return "";
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(stripped).replace(/\s+/g, " ").trim();
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
