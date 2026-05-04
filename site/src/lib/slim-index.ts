// Pure in-memory slim-index types + filter / sort engine.
//
// The progressive loader (fetch + Worker) lives in slim-index-loader.ts
// — it can only run in a real browser, so it's exercised by Playwright
// e2e and excluded from per-file coverage thresholds. This file holds
// everything that's testable with bun:test.
//
// The on-wire format (see scraper/src/db/slim-index.ts ChunkRowOnWire):
//   { i, a, t, ti, c, l, w, r, s, loc, cc, p, f, cm, cmax, cur }
// kept short so JSON.parse over millions of keys stays cheap.

import { type Token as ParsedToken, parseSearchInput } from "./search-parser.ts";

/** A row's representation in memory, as emitted by the slim-index. */
export interface SlimRow {
  /** First 16 hex chars of the canonical Job.id; uniquely identifies the row for SQLite click-through. */
  readonly short_id: string;
  readonly ats: string;
  readonly tenant_slug: string;
  readonly title: string;
  readonly company: string;
  readonly level: string | null;
  readonly workplace_type: string | null;
  readonly is_recruiter_post: boolean;
  readonly is_stale: boolean;
  readonly location_text: string | null;
  readonly location_country: string | null;
  readonly posted_at: string | null;
  readonly first_seen_at: string;
  readonly compensation_min: number | null;
  readonly compensation_max: number | null;
  readonly compensation_currency: string | null;
}

/** On-wire chunk row (compact keys to keep JSON.parse fast). */
export interface ChunkRowOnWire {
  i: string;
  a: string;
  t: string;
  ti: string;
  c: string;
  l: string | null;
  w: string | null;
  r: 0 | 1;
  s: 0 | 1;
  loc: string | null;
  cc: string | null;
  p: string | null;
  f: string;
  cm: number | null;
  cmax: number | null;
  cur: string | null;
}

function fromWire(r: ChunkRowOnWire): SlimRow {
  return {
    short_id: r.i,
    ats: r.a,
    tenant_slug: r.t,
    title: r.ti,
    company: r.c,
    level: r.l,
    workplace_type: r.w,
    is_recruiter_post: r.r === 1,
    is_stale: r.s === 1,
    location_text: r.loc,
    location_country: r.cc,
    posted_at: r.p,
    first_seen_at: r.f,
    compensation_min: r.cm,
    compensation_max: r.cmax,
    compensation_currency: r.cur,
  };
}

function appendUnique(target: SlimRow[], incoming: ReadonlyArray<SlimRow>): void {
  if (target.length === 0) {
    target.push(...incoming);
    return;
  }
  const existing = new Set<string>(target.map((r) => r.short_id));
  for (const r of incoming) {
    if (!existing.has(r.short_id)) {
      target.push(r);
      existing.add(r.short_id);
    }
  }
}

/**
 * Internal helpers shared with slim-index-loader.ts and exposed for
 * unit testing. Not part of the public API surface.
 */
// biome-ignore lint/style/useNamingConvention: snake_case + double underscore is the conventional "private/internal" pattern in TS
export const __test_internals = {
  fromWire,
  appendUnique,
};

/**
 * Filter predicate for the in-memory dataset. Mirrors the SQL plan
 * the legacy SQLite path produced — keeping the contract identical
 * minimises the FilterTable refactor.
 */
export interface FilterPredicate {
  readonly q?: string; // free-text, lowercased
  readonly ats?: ReadonlySet<string>;
  readonly level?: ReadonlySet<string>;
  readonly workplace_type?: ReadonlySet<string>;
  readonly country?: string;
  readonly hideRecruiter?: boolean;
  readonly hideStale?: boolean;
  readonly minComp?: number;
  readonly sinceMs?: number; // absolute epoch ms — rows with posted_at >= this pass
  readonly idAllowlist?: ReadonlySet<string>; // 16-char short_ids
}

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

/**
 * Compiled search token: the parsed field scope from search-parser plus
 * the user value pre-compiled into a case-insensitive regex. Bare tokens
 * (field=undefined) match across all searchable slim-index fields;
 * field-scoped tokens are restricted. We compile once per filterRows
 * call instead of per row.
 */
interface CompiledSearchToken {
  readonly field: ParsedToken["field"];
  readonly regex: RegExp;
}

/** Run the predicate over `rows` and return up to `limit` matching rows in input order. */
export function filterRows(
  rows: ReadonlyArray<SlimRow>,
  pred: FilterPredicate,
  offset: number,
  limit: number,
): { matches: SlimRow[]; total: number } {
  // Parse the raw query into tokens once. The parser handles quoted
  // phrases, field scoping (title: / company: / location: /
  // description:), and bare-word AND. A single bare word collapses to
  // one token that matches the legacy substring path exactly, so
  // existing callers passing q="engineer" keep their behavior.
  const tokens = pred.q ? parseSearchInput(pred.q) : [];
  const compiled: CompiledSearchToken[] = tokens.map((t) => ({
    field: t.field,
    regex: new RegExp(escapeRegExp(t.value), "i"),
  }));
  const matches: SlimRow[] = [];
  let total = 0;
  for (const r of rows) {
    if (!matchesPredicate(r, pred, compiled)) continue;
    total += 1;
    if (total > offset && matches.length < limit) matches.push(r);
    // Don't break early — total count is needed for paginator.
  }
  return { matches, total };
}

function escapeRegExp(s: string): string {
  return s.replace(ESCAPE_RE, "\\$&");
}

function matchesEnum(r: SlimRow, pred: FilterPredicate): boolean {
  if (pred.idAllowlist && !pred.idAllowlist.has(r.short_id)) return false;
  if (pred.ats && !pred.ats.has(r.ats)) return false;
  if (pred.level && (r.level === null || !pred.level.has(r.level))) return false;
  if (
    pred.workplace_type &&
    (r.workplace_type === null || !pred.workplace_type.has(r.workplace_type))
  ) {
    return false;
  }
  if (pred.country !== undefined && r.location_country !== pred.country) return false;
  return true;
}

function matchesScalar(r: SlimRow, pred: FilterPredicate): boolean {
  if (pred.hideRecruiter && r.is_recruiter_post) return false;
  if (pred.hideStale && r.is_stale) return false;
  if (pred.minComp !== undefined) {
    if (r.compensation_min === null) return false;
    if (r.compensation_min < pred.minComp) return false;
  }
  if (pred.sinceMs !== undefined) {
    if (r.posted_at === null) return false;
    const t = Date.parse(r.posted_at);
    if (!Number.isFinite(t) || t < pred.sinceMs) return false;
  }
  return true;
}

function matchesText(r: SlimRow, tokens: ReadonlyArray<CompiledSearchToken>): boolean {
  // Empty tokens = no q filter, pass everything.
  if (tokens.length === 0) return true;
  // All tokens AND-joined.
  for (const t of tokens) {
    if (!matchesToken(r, t)) return false;
  }
  return true;
}

function matchesToken(r: SlimRow, t: CompiledSearchToken): boolean {
  if (t.field === "title") return t.regex.test(r.title);
  if (t.field === "company") return t.regex.test(r.company);
  if (t.field === "location") {
    return r.location_text !== null && t.regex.test(r.location_text);
  }
  if (t.field === "description") {
    // Description excerpts intentionally aren't shipped to the slim-
    // index — they stay in the role-detail SQLite path so the per-
    // visit JSON payload stays under the mobile-bandwidth budget. A
    // description-scoped token therefore matches nothing rather than
    // silently falling through to the title (which would mislead the
    // user about what's being searched). The UI doesn't advertise
    // description: as a supported scope; this branch only fires if
    // someone types it manually.
    return false;
  }
  // Bare token (field === undefined): match across every searchable
  // field the slim-index ships. Order roughly by hit-frequency so a
  // typical match short-circuits early.
  if (t.regex.test(r.title)) return true;
  if (t.regex.test(r.company)) return true;
  if (r.location_text !== null && t.regex.test(r.location_text)) return true;
  if (r.workplace_type !== null && t.regex.test(r.workplace_type)) return true;
  if (r.level !== null && t.regex.test(r.level)) return true;
  return false;
}

function matchesPredicate(
  r: SlimRow,
  pred: FilterPredicate,
  tokens: ReadonlyArray<CompiledSearchToken>,
): boolean {
  return matchesEnum(r, pred) && matchesScalar(r, pred) && matchesText(r, tokens);
}

/**
 * Sort a list of rows by the given key, in place. Mirrors the SQL
 * SORT_TO_ORDER_BY map in filter-sql.ts. NULL handling: nulls sort
 * to the end regardless of direction (matches `NULLS LAST`).
 */
export function sortRows(rows: SlimRow[], sort: SortKey): void {
  const cmp = SORT_COMPARATORS[sort];
  rows.sort(cmp);
}

export type SortKey =
  | "posted_at:desc"
  | "posted_at:asc"
  | "first_seen:desc"
  | "first_seen:asc"
  | "company:asc"
  | "company:desc"
  | "level:asc"
  | "level:desc";

/**
 * Maps level strings to ranks for ORDER BY level. Mirrors the
 * level_rank column the SQLite path uses (see scraper/src/build-job.ts
 * level_rank computation). Null / unknown levels rank as 0 and sort
 * to the end (NULLS LAST in both directions).
 */
const LEVEL_RANK: Record<string, number> = {
  intern: 1,
  junior: 2,
  mid: 3,
  senior: 4,
  staff: 5,
  principal: 6,
  exec: 7,
};

function nullsLastDesc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a > b ? -1 : 1;
}

function nullsLastAsc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

const SORT_COMPARATORS: Record<SortKey, (a: SlimRow, b: SlimRow) => number> = {
  "posted_at:desc": (a, b) => {
    const c = nullsLastDesc(a.posted_at, b.posted_at);
    if (c !== 0) return c;
    return a.first_seen_at > b.first_seen_at ? -1 : a.first_seen_at < b.first_seen_at ? 1 : 0;
  },
  "posted_at:asc": (a, b) => {
    const c = nullsLastAsc(a.posted_at, b.posted_at);
    if (c !== 0) return c;
    return a.first_seen_at < b.first_seen_at ? -1 : a.first_seen_at > b.first_seen_at ? 1 : 0;
  },
  "first_seen:desc": (a, b) =>
    a.first_seen_at > b.first_seen_at ? -1 : a.first_seen_at < b.first_seen_at ? 1 : 0,
  "first_seen:asc": (a, b) =>
    a.first_seen_at < b.first_seen_at ? -1 : a.first_seen_at > b.first_seen_at ? 1 : 0,
  "company:asc": (a, b) => a.company.localeCompare(b.company, undefined, { sensitivity: "base" }),
  "company:desc": (a, b) => b.company.localeCompare(a.company, undefined, { sensitivity: "base" }),
  "level:asc": (a, b) => {
    const ra = a.level === null ? 0 : (LEVEL_RANK[a.level] ?? 0);
    const rb = b.level === null ? 0 : (LEVEL_RANK[b.level] ?? 0);
    // Nulls / unknowns sort to the end in both directions.
    if (ra === 0 && rb !== 0) return 1;
    if (rb === 0 && ra !== 0) return -1;
    if (ra !== rb) return ra - rb;
    // Tiebreak by posted_at DESC (matches the SQL plan).
    return nullsLastDesc(a.posted_at, b.posted_at);
  },
  "level:desc": (a, b) => {
    const ra = a.level === null ? 0 : (LEVEL_RANK[a.level] ?? 0);
    const rb = b.level === null ? 0 : (LEVEL_RANK[b.level] ?? 0);
    if (ra === 0 && rb !== 0) return 1;
    if (rb === 0 && ra !== 0) return -1;
    if (ra !== rb) return rb - ra;
    return nullsLastDesc(a.posted_at, b.posted_at);
  },
};
