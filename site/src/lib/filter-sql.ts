import type { FilterState } from "./filter-state.ts";

export interface QueryPlan {
  readonly sql: string;
  readonly params: ReadonlyArray<string | number>;
}

const DESKTOP_PAGE_SIZE = 50;

const SORT_TO_ORDER_BY: Record<FilterState["sort"], string> = {
  "posted_at:desc": "posted_at DESC NULLS LAST, first_seen_at DESC",
  "posted_at:asc": "posted_at ASC NULLS LAST, first_seen_at ASC",
  "first_seen:desc": "first_seen_at DESC",
  "company:asc": "company COLLATE NOCASE ASC",
  "company:desc": "company COLLATE NOCASE DESC",
  "level:asc": "level_rank ASC NULLS LAST, posted_at DESC",
};

const SINCE_TO_HOURS: Record<FilterState["since"], number | null> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
  all: null,
};

function ftsPhrase(q: string): string {
  return `"${q.replace(/"/g, '""')}"`;
}

export function buildFilterQuery(
  state: FilterState,
  pageSize: number = DESKTOP_PAGE_SIZE,
): QueryPlan {
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (state.q.trim().length > 0) {
    where.push(`jobs.rowid IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ?)`);
    params.push(ftsPhrase(state.q.trim()));
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
    `description_excerpt, posted_at, first_seen_at, url ` +
    `FROM jobs ${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  params.push(pageSize, offset);
  return { sql, params };
}

export function buildFilterCountQuery(state: FilterState): QueryPlan {
  const plan = buildFilterQuery(state);
  const fromIdx = plan.sql.indexOf("FROM jobs");
  const orderIdx = plan.sql.indexOf("ORDER BY");
  const whereSegment = plan.sql.slice(fromIdx, orderIdx).trim();
  const countSql = `SELECT COUNT(*) AS c FROM ${whereSegment.slice("FROM ".length)}`;
  return { sql: countSql, params: plan.params.slice(0, plan.params.length - 2) };
}
