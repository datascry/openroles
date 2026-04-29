/**
 * Phase 13 — search-parser.
 *
 * Tokenizes the search-input string into a list of `{field, value}` tokens
 * and emits an FTS5 expression + a list of LIKE parameters for the SQL
 * builder to AND-join into the WHERE clause.
 *
 * See specs/filter-ui.md v1.2.0 §Advanced syntax for the contract this
 * module implements.
 */

const MAX_TOKENS = 16;

const FTS_FIELDS = ["title", "company", "description"] as const;
type FtsField = (typeof FTS_FIELDS)[number];

const FTS_FIELD_TO_COLUMN: Record<FtsField, string> = {
  title: "title",
  company: "company",
  description: "description_excerpt",
};

const LOCATION_FIELD = "location" as const;
type LocationField = typeof LOCATION_FIELD;

export type Field = FtsField | LocationField;

export interface Token {
  /** Recognized field name, or undefined for bare terms. */
  readonly field: Field | undefined;
  /** Trimmed, non-empty user value. Quoting / escaping happens at emit time. */
  readonly value: string;
}

const KNOWN_FIELDS: ReadonlyArray<string> = [...FTS_FIELDS, LOCATION_FIELD];

/**
 * Match the four token shapes from the spec, in order of specificity:
 *   1. field:"quoted value"
 *   2. field:bareword
 *   3. "quoted value"
 *   4. bareword
 *
 * Field names are bounded `[a-z]{1,16}` so a stray colon in a URL slug
 * (`https://x/a:b`) cannot be mis-parsed as a field. Bareword tokens
 * exclude whitespace; quoted strings preserve internal whitespace.
 *
 * The expression is anchored with the `g` flag so `String#matchAll`
 * walks the input once and yields all tokens in order.
 */
const TOKEN_RE =
  /(?<fq>[a-z]{1,16}):"(?<fqv>[^"]*)"|(?<fb>[a-z]{1,16}):(?<fbv>\S+)|"(?<qv>[^"]*)"|(?<bv>\S+)/g;

/**
 * Parse the search input into an ordered token list. Tokens are bounded
 * at MAX_TOKENS to short-circuit pathological inputs; everything past the
 * cap is silently dropped. Field names that are not in the known set fall
 * back to a bare-term token whose value embeds the original `field:rest`
 * literal — the spec's "unknown-field falls through" rule.
 */
export function parseSearchInput(raw: string): ReadonlyArray<Token> {
  if (typeof raw !== "string") return [];
  const out: Token[] = [];
  for (const match of raw.matchAll(TOKEN_RE)) {
    if (out.length >= MAX_TOKENS) break;
    const groups = match.groups as
      | {
          fq?: string;
          fqv?: string;
          fb?: string;
          fbv?: string;
          qv?: string;
          bv?: string;
        }
      | undefined;
    if (!groups) continue;

    if (groups.fq !== undefined && groups.fqv !== undefined) {
      const value = groups.fqv.trim();
      if (value.length === 0) continue;
      const field = isKnownField(groups.fq);
      if (field !== undefined) out.push({ field, value });
      else out.push({ field: undefined, value: `${groups.fq}:${value}` });
    } else if (groups.fb !== undefined && groups.fbv !== undefined) {
      const value = groups.fbv.trim();
      if (value.length === 0) continue;
      const field = isKnownField(groups.fb);
      if (field !== undefined) out.push({ field, value });
      else out.push({ field: undefined, value: `${groups.fb}:${value}` });
    } else if (groups.qv !== undefined) {
      const value = groups.qv.trim();
      if (value.length === 0) continue;
      out.push({ field: undefined, value });
    } else if (groups.bv !== undefined) {
      const value = groups.bv.trim();
      if (value.length === 0) continue;
      // `title:` with no value falls through here as the literal bare-term
      // `title:`. Drop it — a user typing a field prefix without a value
      // clearly meant a field token, and treating it as a literal phrase
      // generates noise (matches roles literally containing the colon).
      if (/^[a-z]{1,16}:$/.test(value)) continue;
      out.push({ field: undefined, value });
    }
  }
  return out;
}

function isKnownField(s: string): Field | undefined {
  return (KNOWN_FIELDS as ReadonlyArray<string>).includes(s) ? (s as Field) : undefined;
}

/**
 * Quote-escape a value into an FTS5 phrase literal. Doubles internal `"`
 * to `""` per FTS5 grammar so user input cannot escape the phrase and
 * inject operators.
 */
function ftsPhrase(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Escape LIKE meta-characters before substring-wrapping. Without this,
 * a user typing `50%` would match every row (the LIKE wildcard). The
 * escape character is `\` and we declare it via `ESCAPE '\'` in the SQL
 * builder. Backslashes themselves get escaped first to avoid double-
 * escaping.
 */
export function escapeLike(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_")
    .replace(/\[/g, "\\[");
}

/**
 * Build the FTS5 MATCH expression for the FTS-indexed tokens, or null
 * when no FTS-token is present (the SQL builder skips the `MATCH` clause
 * entirely in that case).
 */
export function buildFtsExpression(tokens: ReadonlyArray<Token>): string | null {
  const parts: string[] = [];
  for (const t of tokens) {
    if (t.field === LOCATION_FIELD) continue;
    if (t.field === undefined) {
      parts.push(ftsPhrase(t.value));
    } else {
      const column = FTS_FIELD_TO_COLUMN[t.field];
      parts.push(`{${column}}: ${ftsPhrase(t.value)}`);
    }
  }
  if (parts.length === 0) return null;
  return parts.join(" AND ");
}

/**
 * Extract the location tokens as raw values (not yet wrapped with `%`s).
 * The SQL builder is responsible for emitting `LIKE ? COLLATE NOCASE
 * ESCAPE '\'` per parameter and prefixing/suffixing `%` to the value.
 */
export function extractLocationValues(tokens: ReadonlyArray<Token>): ReadonlyArray<string> {
  const out: string[] = [];
  for (const t of tokens) {
    if (t.field === LOCATION_FIELD) out.push(t.value);
  }
  return out;
}
