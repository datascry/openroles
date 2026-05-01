// SQL for the per-role detail view.
//
// The detail page reads `?id=<short_id>` from the URL where short_id is the
// first 16 hex chars of the canonical Job.id (SHA-256 hex over ats,
// tenant_slug, source_id, url). Sixteen hex chars is 64 bits — plenty of
// space against ~10^5 active rows; collision probability ~3×10^-10.
//
// See specs/role-detail.md.

export interface QueryPlan {
  readonly sql: string;
  readonly params: ReadonlyArray<string | number>;
}

const SHORT_ID_RE = /^[0-9a-f]{16}$/;

export function isShortId(input: string | undefined | null): input is string {
  if (typeof input !== "string") return false;
  return SHORT_ID_RE.test(input);
}

const ROLE_COLUMNS =
  "id, ats, tenant_slug, source_id, title, company, description_excerpt, " +
  "level, level_rank, workplace_type, is_recruiter_post, " +
  "location_text, location_country, location_region, " +
  "compensation_min, compensation_max, compensation_currency, department, " +
  "posted_at, updated_at, first_seen_at, last_seen_at, is_stale, url";

/**
 * Build the SELECT plan that resolves a 16-char short id to the full role
 * row. Uses the existing idx_jobs_id index via a `substr(id, 1, 16) = ?`
 * predicate. LIMIT 1 in case of the 64-bit collision corner case.
 */
export function buildRoleByShortIdQuery(shortId: string): QueryPlan {
  if (!isShortId(shortId)) {
    throw new Error(`buildRoleByShortIdQuery: not a 16-char hex id: ${shortId}`);
  }
  return {
    sql: `SELECT ${ROLE_COLUMNS} FROM jobs WHERE substr(id, 1, 16) = ? LIMIT 1`,
    params: [shortId],
  };
}

/**
 * Truncate a full 64-char Job.id to the 16-char short form used in URLs.
 * Symmetric: `shortIdFromJobId(jobId).startsWith(shortId)` is the contract.
 */
export function shortIdFromJobId(jobId: string): string {
  return jobId.slice(0, 16);
}
