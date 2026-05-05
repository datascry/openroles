/**
 * DSL parser/composer for the dual-mode search bar (specs/uplift-v2-handoff.md §1).
 *
 * The structured tab exposes three labelled inputs (Title, Company, Location).
 * The DSL string in `FilterState.q` is the canonical store: switching tabs
 * round-trips through `parseQuery` / `composeQuery`. The composer is the
 * inverse of the parser for any `StructuredQuery` value (property-tested).
 */

export interface StructuredQuery {
  /** Title field — `title:value` or `title:"value with spaces"`. */
  readonly title: string;
  /** Company field — `company:value` or `company:"value with spaces"`. */
  readonly company: string;
  /** Location field — `location:value` or `location:"value with spaces"`. */
  readonly location: string;
  /** Anything not bound to a known field, joined by single spaces. */
  readonly freeText: string;
}

const FIELD_RE = /([a-z]{1,16}):"([^"]*)"|([a-z]{1,16}):(\S+)|"([^"]*)"|(\S+)/g;
const KNOWN_FIELDS: ReadonlyArray<keyof StructuredQuery> = ["title", "company", "location"];

export const Q_TOTAL_MAX = 256;
export const Q_FIELD_MAX = 64;

/**
 * Parse a query string into structured + free-text components. Tokens for
 * known fields collapse into the named slot — duplicates concatenate with a
 * single space so structured rendering still surfaces both. Unknown
 * `xyz:foo` tokens fall through into `freeText` as the literal `xyz:foo`,
 * matching the existing search-parser fallback.
 */
export function parseQuery(q: string): StructuredQuery {
  if (typeof q !== "string" || q.length === 0) {
    return { title: "", company: "", location: "", freeText: "" };
  }
  const acc: { title: string[]; company: string[]; location: string[]; freeText: string[] } = {
    title: [],
    company: [],
    location: [],
    freeText: [],
  };
  for (const match of q.matchAll(FIELD_RE)) {
    const [, fq, fqv, fb, fbv, qv, bv] = match;
    if (fq !== undefined && fqv !== undefined) {
      pushField(acc, fq, fqv);
    } else if (fb !== undefined && fbv !== undefined) {
      pushField(acc, fb, fbv);
    } else if (qv !== undefined) {
      if (qv.trim().length > 0) acc.freeText.push(qv);
    } else if (bv !== undefined) {
      if (bv.trim().length > 0) acc.freeText.push(bv);
    }
  }
  return {
    title: acc.title.join(" ").trim(),
    company: acc.company.join(" ").trim(),
    location: acc.location.join(" ").trim(),
    freeText: acc.freeText.join(" ").trim(),
  };
}

function pushField(
  acc: { title: string[]; company: string[]; location: string[]; freeText: string[] },
  field: string,
  value: string,
): void {
  const trimmed = value.trim();
  if (trimmed.length === 0) return;
  const known = (KNOWN_FIELDS as ReadonlyArray<string>).includes(field);
  if (known) {
    acc[field as keyof StructuredQuery].push(trimmed);
  } else {
    acc.freeText.push(`${field}:${trimmed}`);
  }
}

/**
 * Compose a `StructuredQuery` into a single DSL string.
 *
 * Round-trip rules (so `parseQuery(composeQuery(s)) ≡ s.trimmed` holds):
 *   - Field values are trimmed before emission. Embedded `"` characters are
 *     stripped (the DSL has no escape grammar; preserving them would either
 *     break the regex or require an escape token the search-parser does not
 *     understand). Trailing/leading whitespace inside the value is preserved
 *     by quoting only — outer trim happens in the parser.
 *   - Field tokens are always quoted, regardless of whitespace, so the
 *     parser treats them as phrases consistently.
 *   - Free-text tokens that look like `field:value` (would be re-bucketed)
 *     are quoted so the parser keeps them as bare phrases.
 *
 * Throws if the composed length exceeds `Q_TOTAL_MAX`.
 */
export function composeQuery(s: StructuredQuery): string {
  const parts: string[] = [];
  const cleanField = (v: string) => v.replace(/"/g, "").trim();
  const t = cleanField(s.title);
  const c = cleanField(s.company);
  const l = cleanField(s.location);
  if (t) parts.push(`title:"${t}"`);
  if (c) parts.push(`company:"${c}"`);
  if (l) parts.push(`location:"${l}"`);
  const ft = s.freeText.trim();
  if (ft) parts.push(quoteFreeTextIfNeeded(ft));
  const composed = parts.join(" ");
  if (composed.length > Q_TOTAL_MAX) {
    throw new RangeError(
      `composeQuery: composed length ${composed.length} exceeds ${Q_TOTAL_MAX} char cap`,
    );
  }
  return composed;
}

function quoteFreeTextIfNeeded(value: string): string {
  // A bare-word free-text token can survive unquoted only if it contains no
  // `:` and no whitespace. Otherwise quote so the parser keeps it as a
  // single freeText phrase.
  const stripped = value.replace(/"/g, "");
  if (/[\s:]/.test(stripped)) return `"${stripped}"`;
  return stripped;
}

/**
 * Return whether the structured slot has any content beyond `freeText` —
 * used by the SearchBar to decide which tab indicator to show on first paint.
 */
export function hasStructured(s: StructuredQuery): boolean {
  return s.title.length > 0 || s.company.length > 0 || s.location.length > 0;
}
