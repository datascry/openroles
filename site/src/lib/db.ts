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
  return process.env["OPENROLES_DATA_DIR"] ?? "./data";
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
  "id, ats, tenant_slug, source_id, title, company, description_excerpt, level, level_rank, workplace_type, is_recruiter_post, location_text, location_country, location_region, compensation_min, compensation_max, compensation_currency, department, posted_at, updated_at, first_seen_at, last_seen_at, url";

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
  return db
    .query(
      `SELECT t.ats AS ats, t.slug AS slug, t.display_name AS display_name,
              t.homepage_url AS homepage_url, t.status AS status,
              COUNT(j.id) AS job_count
       FROM tenants t
       LEFT JOIN jobs j ON j.ats = t.ats AND j.tenant_slug = t.slug
       GROUP BY t.ats, t.slug
       ORDER BY t.ats ASC, t.slug ASC`,
    )
    .all() as TenantPageRow[];
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
