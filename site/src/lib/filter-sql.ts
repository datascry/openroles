import type { FilterState } from "./filter-state.ts";
import {
  buildFtsExpression,
  escapeLike,
  extractLocationValues,
  parseSearchInput,
} from "./search-parser.ts";

export interface QueryPlan {
  readonly sql: string;
  readonly params: ReadonlyArray<string | number>;
}

const DESKTOP_PAGE_SIZE = 50;

const SORT_TO_ORDER_BY: Record<FilterState["sort"], string> = {
  "posted_at:desc": "posted_at DESC NULLS LAST, first_seen_at DESC",
  "posted_at:asc": "posted_at ASC NULLS LAST, first_seen_at ASC",
  "first_seen:desc": "first_seen_at DESC",
  "first_seen:asc": "first_seen_at ASC",
  "company:asc": "company COLLATE NOCASE ASC",
  "company:desc": "company COLLATE NOCASE DESC",
  "level:asc": "level_rank ASC NULLS LAST, posted_at DESC",
  "level:desc": "level_rank DESC NULLS LAST, posted_at DESC",
};

const SINCE_TO_HOURS: Record<FilterState["since"], number | null> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
  "90d": 24 * 90,
  all: null,
};

export interface BuildFilterOptions {
  readonly pageSize?: number;
  /**
   * When provided, the query is restricted to rows whose `id` appears in
   * this list — used to render the "Show only Saved / Applied / Ignored"
   * sub-views per specs/filter-ui.md v1.2.0. An empty array narrows to
   * zero rows (preferable to silently expanding to the unfiltered set).
   */
  readonly idAllowlist?: ReadonlyArray<string>;
}

export function buildFilterQuery(
  state: FilterState,
  optionsOrPageSize: BuildFilterOptions | number = DESKTOP_PAGE_SIZE,
): QueryPlan {
  // Tolerate the legacy positional `pageSize` arg from existing call
  // sites + tests; new callers pass the options object directly.
  const options: BuildFilterOptions =
    typeof optionsOrPageSize === "number" ? { pageSize: optionsOrPageSize } : optionsOrPageSize;
  const pageSize = options.pageSize ?? DESKTOP_PAGE_SIZE;

  const where: string[] = [];
  const params: Array<string | number> = [];

  if (options.idAllowlist !== undefined) {
    if (options.idAllowlist.length === 0) {
      // Empty allowlist → zero rows. `id = ''` is tautologically false
      // because Job.id is a 64-char SHA-256 hex.
      where.push(`id = ''`);
    } else {
      where.push(`id IN (${options.idAllowlist.map(() => "?").join(",")})`);
      for (const id of options.idAllowlist) params.push(id);
    }
  }

  if (state.q.trim().length > 0) {
    // Phase 13: parse the search input as a list of `field:value` tokens
    // (specs/filter-ui.md v1.2.0). FTS-indexed tokens (title, company,
    // description) compose into a single jobs_fts MATCH expression;
    // location tokens emit per-token LIKE clauses that match
    // location_text case-insensitively. Plain free-text falls through
    // to the FTS path with a single bare phrase, preserving the
    // pre-Phase-13 behavior.
    const tokens = parseSearchInput(state.q.trim());
    const ftsExpr = buildFtsExpression(tokens);
    if (ftsExpr !== null) {
      where.push(`jobs.rowid IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ?)`);
      params.push(ftsExpr);
    }
    for (const value of extractLocationValues(tokens)) {
      where.push(`location_text LIKE ? ESCAPE '\\' COLLATE NOCASE`);
      params.push(`%${escapeLike(value)}%`);
    }
  }
  if (state.ats.length > 0) {
    where.push(`ats IN (${state.ats.map(() => "?").join(",")})`);
    for (const a of state.ats) params.push(a);
  }
  if (state.level.length > 0) {
    where.push(`level IN (${state.level.map(() => "?").join(",")})`);
    for (const l of state.level) params.push(l);
  }
  if (state.wt.length > 0) {
    where.push(`workplace_type IN (${state.wt.map(() => "?").join(",")})`);
    for (const w of state.wt) params.push(w);
  }
  if (state.country) {
    where.push(`location_country = ?`);
    params.push(state.country);
  }
  if (state.region) {
    where.push(`location_region = ?`);
    params.push(state.region);
  }
  const sinceHours = SINCE_TO_HOURS[state.since];
  if (sinceHours !== null) {
    where.push(`posted_at IS NOT NULL AND posted_at >= datetime('now', '-' || ? || ' hours')`);
    params.push(sinceHours);
  }
  if (state.hideRecruiter) {
    where.push(`is_recruiter_post = 0`);
  }
  if (state.hideStale) {
    where.push(`is_stale = 0`);
  }
  if (state.minComp !== undefined) {
    where.push(`compensation_min IS NOT NULL AND compensation_min >= ?`);
    params.push(state.minComp);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = SORT_TO_ORDER_BY[state.sort];
  const offset = (state.page - 1) * pageSize;
  const sql =
    `SELECT id, ats, tenant_slug, title, company, location_text, location_country, ` +
    `location_region, level, level_rank, workplace_type, is_recruiter_post, ` +
    `description_excerpt, posted_at, first_seen_at, last_seen_at, is_stale, url ` +
    `FROM jobs ${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  params.push(pageSize, offset);
  return { sql, params };
}

export function buildFilterCountQuery(state: FilterState, options?: BuildFilterOptions): QueryPlan {
  const plan = buildFilterQuery(state, options ?? {});
  const fromIdx = plan.sql.indexOf("FROM jobs");
  const orderIdx = plan.sql.indexOf("ORDER BY");
  const whereSegment = plan.sql.slice(fromIdx, orderIdx).trim();
  const countSql = `SELECT COUNT(*) AS c FROM ${whereSegment.slice("FROM ".length)}`;
  return { sql: countSql, params: plan.params.slice(0, plan.params.length - 2) };
}
