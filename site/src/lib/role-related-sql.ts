/**
 * Query builder for the "More from {company}" card on the role-detail page
 * (specs/uplift-v2-handoff.md §3.4). Returns up to `limit` other live roles
 * for the same tenant, excluding the current role's full id.
 */

export interface QueryPlan {
  readonly sql: string;
  readonly params: ReadonlyArray<string | number>;
}

const TENANT_SLUG_RE = /^[a-z0-9_-]{1,128}$/;
const HEX_FULL_ID_RE = /^[0-9a-f]{64}$/;

const RELATED_COLUMNS =
  "id, ats, tenant_slug, title, posted_at, first_seen_at, level, workplace_type";

/**
 * Build the SELECT for related roles. Filters by `tenant_slug`, excludes the
 * passed-in role id, orders by `posted_at DESC NULLS LAST` then `first_seen_at DESC`,
 * caps at `limit` (default 4).
 *
 * Throws on invalid input rather than silently emitting an empty plan — the
 * caller should never reach this without a valid role row in hand.
 */
export function buildRelatedRolesQuery(
  tenantSlug: string,
  excludeId: string,
  limit = 4,
): QueryPlan {
  if (typeof tenantSlug !== "string" || !TENANT_SLUG_RE.test(tenantSlug)) {
    throw new Error(`buildRelatedRolesQuery: invalid tenant_slug: ${tenantSlug}`);
  }
  if (typeof excludeId !== "string" || !HEX_FULL_ID_RE.test(excludeId)) {
    throw new Error(`buildRelatedRolesQuery: invalid excludeId: ${excludeId}`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error(`buildRelatedRolesQuery: invalid limit: ${limit}`);
  }
  return {
    sql: `SELECT ${RELATED_COLUMNS} FROM jobs
WHERE tenant_slug = ? AND id != ? AND is_stale = 0
ORDER BY posted_at IS NULL ASC, posted_at DESC, first_seen_at DESC
LIMIT ?`,
    params: [tenantSlug, excludeId, limit],
  };
}

/**
 * Build the COUNT for the "All N {Company} roles" link below the card.
 * Excludes the current role and stale rows for the same reason as above.
 */
export function buildRelatedRolesCountQuery(tenantSlug: string, excludeId: string): QueryPlan {
  if (typeof tenantSlug !== "string" || !TENANT_SLUG_RE.test(tenantSlug)) {
    throw new Error(`buildRelatedRolesCountQuery: invalid tenant_slug: ${tenantSlug}`);
  }
  if (typeof excludeId !== "string" || !HEX_FULL_ID_RE.test(excludeId)) {
    throw new Error(`buildRelatedRolesCountQuery: invalid excludeId: ${excludeId}`);
  }
  return {
    sql: "SELECT COUNT(*) AS c FROM jobs WHERE tenant_slug = ? AND id != ? AND is_stale = 0",
    params: [tenantSlug, excludeId],
  };
}
