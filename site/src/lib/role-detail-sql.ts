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
 * Build the SELECT plan that resolves a 16-char short id to the full
 * role row. Uses a `BETWEEN` range over the PRIMARY KEY so SQLite can
 * walk the id b-tree directly (~log₂ n page reads). The previous
 * `WHERE substr(id, 1, 16) = ?` form wrapped the indexed column in a
 * function, which forces a full-table scan — over sql.js-httpvfs that
 * meant fetching the entire jobs table just to render one role page.
 *
 * The hex range is `<shortId>00…0` (48 zero hex digits) inclusive
 * through `<shortId>ff…f` (48 f hex digits) inclusive, since `id` is a
 * 64-char SHA-256 hex string. Strings sort lexicographically over the
 * default BINARY collation, so the range is exactly the set of ids
 * whose first 16 chars match `shortId`. LIMIT 1 keeps us honest if
 * the 64-bit collision corner case ever fires.
 */
const HEX_PAD_LOW = "0".repeat(48);
const HEX_PAD_HIGH = "f".repeat(48);

export function buildRoleByShortIdQuery(shortId: string): QueryPlan {
  if (!isShortId(shortId)) {
    throw new Error(`buildRoleByShortIdQuery: not a 16-char hex id: ${shortId}`);
  }
  const lo = shortId + HEX_PAD_LOW;
  const hi = shortId + HEX_PAD_HIGH;
  return {
    sql: `SELECT ${ROLE_COLUMNS} FROM jobs WHERE id BETWEEN ? AND ? LIMIT 1`,
    params: [lo, hi],
  };
}

/**
 * Truncate a full 64-char Job.id to the 16-char short form used in URLs.
 * Symmetric: `shortIdFromJobId(jobId).startsWith(shortId)` is the contract.
 */
export function shortIdFromJobId(jobId: string): string {
  return jobId.slice(0, 16);
}
