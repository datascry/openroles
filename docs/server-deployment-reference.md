# Resurrecting the role-detail subsystem on a server backend

This guide describes how to revive the per-role detail page, FTS5
search, and SQL-backed query runtime that lived in this repo through
git tag `archive/v1-full-stack` (commit
`af381e52ccd59c02de05fa7248748d2119704a8f`). The decision to remove the
subsystem is recorded in [ADR-0012](adr/0012-static-only-deployment.md).

The intended target for resurrection is a Postgres-backed deployment
with a small Node / Bun / Hono API in front. Most of the UI and
formatting code transfers without modification because the editorial
role-detail layout was deliberately kept agnostic to its data source.

## What the archive contains

```
$ git checkout archive/v1-full-stack
$ ls site/src/components/RoleDetail.svelte \
     site/src/lib/role-detail-*.ts \
     site/src/lib/role-related-sql.ts \
     site/src/lib/client-db.ts \
     site/src/lib/manifest-runtime.ts \
     site/scripts/copy-sqlite-vfs.ts \
     scraper/src/db/schema.ts
```

| File | Resurrection cost | Notes |
| --- | --- | --- |
| `site/src/components/RoleDetail.svelte` | None | Editorial broadsheet layout (kicker, headline, byline, dropcap, pullquote, sticky-apply). Replace `loadClientDb` with a `fetch('/api/role/{shortId}')` and the rest is pure UI. |
| `site/src/lib/role-detail-format.ts` | None | Pure formatters: `bylineParts`, `pullquote`. Operates on a `RoleForFormat` interface — does not care where the data came from. |
| `site/src/lib/role-detail-helpers.ts` | None | Pure helpers: `freshnessTag`, `bodyParas`, `dropcap`, `relativeDays`, `shortDate`, `strapText`, `shortIdFromUrl`. |
| `site/src/lib/role-detail-sql.ts` | Light | The `WHERE substr(id, 1, 16) = ?` pattern transfers to Postgres. SQLite expression-index → Postgres functional index: `CREATE INDEX idx_jobs_short_id ON jobs(substring(id from 1 for 16));` |
| `site/src/lib/role-related-sql.ts` | Light | Bind-parameter style is the same; replace `?` with `$1, $2, ...` for `pg`. |
| `site/src/lib/client-db.ts` | High | Throw it away. Replace with a 30-line `fetch('/api/role/{shortId}')` wrapper that returns the same `Role` shape. |
| `site/src/lib/manifest-runtime.ts` | None | Throw it away. Server doesn't need a chunked-SQLite manifest. |
| `site/scripts/copy-sqlite-vfs.ts` | None | Throw it away. Server doesn't need the Fastly / GitHub-Pages workarounds. |
| `scraper/src/db/schema.ts` | Medium | Port to Postgres migrations. Notes below. |

## Postgres schema port

The SQLite DDL transfers to Postgres with these substitutions:

| SQLite | Postgres |
| --- | --- |
| `INTEGER PRIMARY KEY` | `BIGSERIAL PRIMARY KEY` (or keep `TEXT PRIMARY KEY` if you want the SHA-256 ids verbatim) |
| `TEXT NOT NULL DEFAULT 0` on `is_recruiter_post` / `is_stale` | `BOOLEAN NOT NULL DEFAULT FALSE` |
| `CREATE VIRTUAL TABLE jobs_fts USING fts5(...)` | Add a `search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', title \|\| ' ' \|\| company \|\| ' ' \|\| coalesce(description_excerpt, ''))) STORED` column + `CREATE INDEX … USING GIN (search_vector)` |
| FTS5 triggers | Drop them — the generated column updates automatically |
| `CREATE INDEX idx_jobs_short_id ON jobs(substr(id, 1, 16))` | `CREATE INDEX idx_jobs_short_id ON jobs(substring(id from 1 for 16))` |
| `PRAGMA page_size = 4096` | Drop — Postgres manages page size internally |

## Minimum viable API

If you want to revive role-detail with the smallest possible surface:

```ts
// server/api/role.ts (Hono / Bun)
app.get("/api/role/:shortId", async (c) => {
  const shortId = c.req.param("shortId");
  if (!/^[0-9a-f]{16}$/.test(shortId)) return c.json({ error: "bad id" }, 400);
  const { rows } = await pool.query(
    "SELECT id, ats, tenant_slug, source_id, title, company, description_excerpt, level, level_rank, workplace_type, is_recruiter_post, location_text, location_country, location_region, compensation_min, compensation_max, compensation_currency, department, posted_at, updated_at, first_seen_at, last_seen_at, is_stale, url FROM jobs WHERE substring(id from 1 for 16) = $1 LIMIT 1",
    [shortId],
  );
  if (rows.length === 0) return c.json({ error: "not found" }, 404);
  return c.json(rows[0]);
});

app.get("/api/role/:shortId/related", async (c) => {
  const shortId = c.req.param("shortId");
  // Resolve the role's tenant_slug + full id, then run the related query
  // from the archived role-related-sql.ts.
  // ...
});
```

Then in `RoleDetail.svelte`:

```ts
// Replace:
const db = await loadClientDb({ basePath });
const plan = buildRoleByShortIdQuery(shortId);
const rows = await db.query<Role>(plan.sql, plan.params);

// With:
const res = await fetch(`/api/role/${shortId}`);
if (!res.ok) {
  loadError = res.status === 404
    ? "This role isn't in the current database."
    : `Couldn't load the role (HTTP ${res.status}).`;
} else {
  role = (await res.json()) as Role;
}
```

That's the entire data-layer adapter — every other piece of the role-detail
subsystem (the editorial layout, the byline / pullquote formatters, the
freshness tag, the related-roles card, the sticky-apply observer, the
save / applied / ignored localStorage actions) works without modification.

## What's lost in the archive that you'd want to keep

The archive freezes the per-role page as it existed at the time of removal,
including:

- The editorial broadsheet visual design (kicker, headline, strap, byline,
  dropcap, pullquote, fact card, sticky-apply mobile bar).
- The 16-char `short_id` URL scheme (`/role/?id=<short_id>`).
- The "More from {company}" related-roles card.
- The `STALE` banner and `freshnessTag` derivation rules.
- The role-detail e2e specs at `site/tests/e2e/role-detail.spec.ts`.
- The Stripe Payments fixture data with editorial-friendly description and
  comp band (used to test the pullquote rendering).

If a server deployment ever happens, those tests are the fastest way to
verify the resurrected page behaves identically to the static-archive
baseline.
