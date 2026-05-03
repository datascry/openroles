import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ATSId,
  type Job,
  JobSchema,
  type Level,
  type Manifest,
  ManifestSchema,
} from "@openroles/shared";

function defaultDataDir(): string {
  const env = process.env["OPENROLES_DATA_DIR"];
  if (env !== undefined) return env;
  // CI builds set OPENROLES_DATA_DIR to the workspace `data/` (where build-db
  // writes). The dev server runs from `site/` and serves `public/data/` over
  // HTTP, so fall back to that path so the SSR manifest header sees the same
  // bytes the browser receives.
  if (existsSync("./public/data/manifest.json")) return "./public/data";
  return "./data";
}

export interface SiteDb {
  readonly db: Database;
  readonly manifest: Manifest;
  close(): void;
}

export function openSiteDb(dataDir: string = defaultDataDir()): SiteDb {
  const manifestPath = join(dataDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`openSiteDb: manifest.json not found in ${dataDir}`);
  }
  const manifest = ManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  const sqlitePath = join(dataDir, manifest.db_filename.replace(/\.gz$/, ""));
  if (!existsSync(sqlitePath)) {
    throw new Error(`openSiteDb: ${sqlitePath} not found (manifest references it)`);
  }
  const db = new Database(sqlitePath, { readonly: true });
  return {
    db,
    manifest,
    close: () => db.close(),
  };
}

const FEED_COLUMNS =
  "id, ats, tenant_slug, source_id, title, company, description_excerpt, level, level_rank, workplace_type, is_recruiter_post, location_text, location_country, location_region, compensation_min, compensation_max, compensation_currency, department, posted_at, updated_at, first_seen_at, last_seen_at, is_stale, url";

interface JobRow {
  id: string;
  ats: string;
  tenant_slug: string;
  source_id: string;
  title: string;
  company: string;
  description_excerpt: string | null;
  level: string | null;
  level_rank: number | null;
  workplace_type: string | null;
  is_recruiter_post: number;
  location_text: string | null;
  location_country: string | null;
  location_region: string | null;
  compensation_min: number | null;
  compensation_max: number | null;
  compensation_currency: string | null;
  department: string | null;
  posted_at: string | null;
  updated_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  is_stale: number;
  url: string;
}

function rowToJob(r: JobRow): Job {
  return JobSchema.parse({
    id: r.id,
    ats: r.ats,
    tenant_slug: r.tenant_slug,
    source_id: r.source_id,
    title: r.title,
    company: r.company,
    ...(r.description_excerpt !== null ? { description_excerpt: r.description_excerpt } : {}),
    level: r.level,
    level_rank: r.level_rank,
    workplace_type: r.workplace_type,
    is_recruiter_post: r.is_recruiter_post !== 0,
    ...(r.location_text !== null ? { location_text: r.location_text } : {}),
    ...(r.location_country !== null ? { location_country: r.location_country } : {}),
    ...(r.location_region !== null ? { location_region: r.location_region } : {}),
    ...(r.compensation_min !== null ? { compensation_min: r.compensation_min } : {}),
    ...(r.compensation_max !== null ? { compensation_max: r.compensation_max } : {}),
    ...(r.compensation_currency !== null ? { compensation_currency: r.compensation_currency } : {}),
    ...(r.department !== null ? { department: r.department } : {}),
    ...(r.posted_at !== null ? { posted_at: r.posted_at } : {}),
    ...(r.updated_at !== null ? { updated_at: r.updated_at } : {}),
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    is_stale: r.is_stale !== 0,
    url: r.url,
  });
}

export function selectFeedJobs(
  db: Database,
  filter: { ats?: ATSId; level?: NonNullable<Level> },
  limit = 100,
): Job[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.ats !== undefined) {
    where.push("ats = ?");
    params.push(filter.ats);
  }
  if (filter.level !== undefined) {
    where.push("level = ?");
    params.push(filter.level);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sql =
    `SELECT ${FEED_COLUMNS} FROM jobs ${whereClause} ` +
    `ORDER BY posted_at DESC NULLS LAST, first_seen_at DESC, id ASC LIMIT ?`;
  params.push(limit);
  const rows = db.query(sql).all(...params) as JobRow[];
  return rows.map(rowToJob);
}

export interface TenantPageRow {
  ats: string;
  slug: string;
  display_name: string | null;
  homepage_url: string | null;
  status: string;
  job_count: number;
}

export function selectTenants(db: Database): TenantPageRow[] {
  // HAVING job_count > 0: skip tenants with no jobs in the current
  // SQLite. The empty page would just say "this company has no
  // open roles" — no SEO value, no user value, but each one costs
  // ~13ms of Astro build time. Pre-bootstrap there were ~25k tenants
  // and ~all had jobs; post-bootstrap there are 119k tenants but
  // ~30-40k have actual jobs (the rest are historical / dead /
  // recently-discovered-but-unscraped). Filtering here drops the
  // tenant-page enumeration from 119k pages to ~30-40k, which is the
  // difference between busting the 30-min build cap and finishing
  // in <10 min.
  return db
    .query(
      `SELECT t.ats AS ats, t.slug AS slug, t.display_name AS display_name,
              t.homepage_url AS homepage_url, t.status AS status,
              COUNT(j.id) AS job_count
       FROM tenants t
       INNER JOIN jobs j ON j.ats = t.ats AND j.tenant_slug = t.slug
       GROUP BY t.ats, t.slug
       HAVING job_count > 0
       ORDER BY t.ats ASC, t.slug ASC`,
    )
    .all() as TenantPageRow[];
}

/**
 * Slim row shape for pre-rendered first paint on the homepage. The
 * Astro page bakes 50 of these into the static HTML so users see real
 * roles before any JS runs — the FilterTable's Svelte island then
 * hydrates over them and the slim-index loader takes over interactive
 * filtering.
 *
 * Distinct from the FEED_COLUMNS shape because we drop description /
 * url / source_id (not needed for the row card) and use camelCase
 * field names so the rendered HTML can be reused directly without
 * adapter code.
 */
export interface FirstPaintRow {
  short_id: string;
  ats: string;
  tenant_slug: string;
  title: string;
  company: string;
  level: string | null;
  workplace_type: string | null;
  is_recruiter_post: boolean;
  is_stale: boolean;
  location_text: string | null;
  location_country: string | null;
  posted_at: string | null;
  first_seen_at: string;
  compensation_min: number | null;
}

interface FirstPaintRowSqlite {
  id: string;
  ats: string;
  tenant_slug: string;
  title: string;
  company: string;
  level: string | null;
  workplace_type: string | null;
  is_recruiter_post: number;
  is_stale: number;
  location_text: string | null;
  location_country: string | null;
  posted_at: string | null;
  first_seen_at: string;
  compensation_min: number | null;
}

export function selectFirstPaintJobs(db: Database, limit = 50): FirstPaintRow[] {
  // Default homepage sort = posted_at DESC. Uses idx_jobs_posted_at
  // (added in Phase 14 schema bump) for index-only walk + LIMIT.
  const sql =
    "SELECT id, ats, tenant_slug, title, company, level, workplace_type, " +
    "is_recruiter_post, is_stale, location_text, location_country, " +
    "posted_at, first_seen_at, compensation_min " +
    "FROM jobs " +
    "ORDER BY posted_at DESC NULLS LAST, first_seen_at DESC LIMIT ?";
  const rows = db.query(sql).all(limit) as FirstPaintRowSqlite[];
  return rows.map((r) => ({
    short_id: r.id.slice(0, 16),
    ats: r.ats,
    tenant_slug: r.tenant_slug,
    title: r.title,
    company: r.company,
    level: r.level,
    workplace_type: r.workplace_type,
    is_recruiter_post: r.is_recruiter_post !== 0,
    is_stale: r.is_stale !== 0,
    location_text: r.location_text,
    location_country: r.location_country,
    posted_at: r.posted_at,
    first_seen_at: r.first_seen_at,
    compensation_min: r.compensation_min,
  }));
}

export function selectTenantJobs(db: Database, ats: string, slug: string, limit = 200): Job[] {
  const sql =
    `SELECT ${FEED_COLUMNS} FROM jobs WHERE ats = ? AND tenant_slug = ? ` +
    `ORDER BY posted_at DESC NULLS LAST, first_seen_at DESC LIMIT ?`;
  const rows = db.query(sql).all(ats, slug, limit) as JobRow[];
  return rows.map(rowToJob);
}

export function dataDirIsPopulated(dataDir: string = defaultDataDir()): boolean {
  if (!existsSync(dataDir)) return false;
  if (!existsSync(join(dataDir, "manifest.json"))) return false;
  return readdirSync(dataDir).some((n) => n.endsWith(".sqlite"));
}
