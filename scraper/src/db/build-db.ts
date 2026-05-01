// biome-ignore-all lint/style/useNamingConvention: SQLite bind names ($tenant_slug, $first_seen_at, ...) MUST be snake_case to match the column names in schema.ts; renaming them is a SQL change, not a code-style change.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: buildDb owns the merge / classify / FTS pipeline; splitting it would force shared mutable state across helpers, which is worse than the current sequence.

import { Database } from "bun:sqlite";
import {
  ATS_IDS,
  type ATSId,
  classifyLevel,
  classifyRecruiter,
  classifyWorkplace,
  type Job,
  levelRank,
  type Manifest,
  ManifestSchema,
  SCHEMA_VERSION,
  type ScrapeOutput,
  STALE_TTL_DAYS_DEFAULT,
  type Tenant,
} from "@openroles/shared";
import {
  FTS_OPTIMIZE_STMT,
  INDEX_DDL,
  PAGE_SIZE_PRAGMA,
  SCHEMA_DDL,
  VACUUM_STMT,
} from "./schema.ts";

export interface BuildDbInput {
  readonly outputs: ReadonlyArray<ScrapeOutput>;
  readonly tenants: ReadonlyArray<Tenant>;
  readonly buildShortSha: string;
  readonly builtAt: string;
  readonly notes?: string;
  /**
   * Path to the previous build's SQLite database. When set, roles present
   * in the previous DB but NOT in today's `outputs` are carried forward as
   * is_stale=1, preserving their original first_seen_at and last_seen_at,
   * until they exceed `staleTtlDays` since their last_seen_at — at which
   * point they drop. See specs/role-lifecycle.md.
   */
  readonly previousDbPath?: string;
  /** Days of staleness before a role drops. Default: STALE_TTL_DAYS_DEFAULT (3). */
  readonly staleTtlDays?: number;
}

interface CarriedRow {
  readonly id: string;
  readonly ats: string;
  readonly tenant_slug: string;
  readonly source_id: string;
  readonly title: string;
  readonly company: string;
  readonly description_excerpt: string | null;
  readonly level: string | null;
  readonly level_rank: number | null;
  readonly workplace_type: string | null;
  readonly is_recruiter_post: number;
  readonly location_text: string | null;
  readonly location_country: string | null;
  readonly location_region: string | null;
  readonly compensation_min: number | null;
  readonly compensation_max: number | null;
  readonly compensation_currency: string | null;
  readonly department: string | null;
  readonly posted_at: string | null;
  readonly updated_at: string | null;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly url: string;
}

export interface BuildDbResult {
  readonly db: Database;
  readonly manifest: Manifest;
}

export function classifyJob(job: Job): Job {
  const level = job.level ?? classifyLevel(job.title);
  const isRecruiter =
    job.is_recruiter_post ||
    classifyRecruiter({
      title: job.title,
      ...(job.department ? { department: job.department } : {}),
    });
  // Fallback workplace classification when the adapter didn't set it.
  // ~half of the adapters (eightfold, jobvite, personio, talentlyft, factorial,
  // and the three stubbed ATSes) leave workplace_type null at scrape time;
  // a title/location/description scan recovers most of them.
  const workplace =
    job.workplace_type ??
    classifyWorkplace({
      title: job.title,
      ...(job.location_text ? { location_text: job.location_text } : {}),
      ...(job.description_excerpt ? { description_excerpt: job.description_excerpt } : {}),
    });
  return {
    ...job,
    level,
    level_rank: levelRank(level),
    is_recruiter_post: isRecruiter,
    workplace_type: workplace,
  };
}

/**
 * Days between two ISO-8601 UTC timestamps, rounded up to whole days at
 * UTC midnight. Used by the stale-TTL window to keep wall-clock effects
 * (a role first seen at 23:59 UTC) from arbitrarily expiring early.
 *
 * Public for property tests in build-db.test.ts.
 */
export function daysSinceUtc(now: string, then: string): number {
  const nowMs = new Date(now).getTime();
  const thenMs = new Date(then).getTime();
  if (Number.isNaN(nowMs) || Number.isNaN(thenMs)) return 0;
  if (nowMs <= thenMs) return 0;
  // Floor each side to UTC midnight then subtract.
  const dayMs = 86_400_000;
  const nowDay = Math.floor(nowMs / dayMs);
  const thenDay = Math.floor(thenMs / dayMs);
  return nowDay - thenDay;
}

/**
 * Read the previous build's `jobs` table. Returns an empty array if the
 * file is missing — first-ever build has nothing to carry forward.
 */
function readPreviousJobs(path: string): ReadonlyArray<CarriedRow> {
  let prev: Database;
  try {
    prev = new Database(path, { readonly: true });
  } catch {
    return [];
  }
  try {
    const rows = prev
      .query<CarriedRow, []>(
        // Pre-1.3.0 DBs lack the is_stale column; we don't read it here.
        // The carry-forward emits is_stale=1 explicitly, so any prior
        // staleness is rederived this build.
        `SELECT id, ats, tenant_slug, source_id, title, company,
                description_excerpt, level, level_rank, workplace_type,
                is_recruiter_post, location_text, location_country,
                location_region, compensation_min, compensation_max,
                compensation_currency, department, posted_at, updated_at,
                first_seen_at, last_seen_at, url
           FROM jobs`,
      )
      .all();
    return rows;
  } finally {
    prev.close();
  }
}

export interface CarryForwardResult {
  readonly carried: ReadonlyArray<CarriedRow>;
  readonly dropped: number;
}

/**
 * Compute which previous-DB rows should carry forward into the new build.
 *
 * @param previousRows  Every row from the previous DB.
 * @param freshIds      The set of `Job.id` values that today's scrape DID
 *                      include — those rows take precedence and are NOT
 *                      carried forward (they will be inserted as fresh).
 * @param freshUrls     The set of `Job.url` values today's scrape includes,
 *                      consulted to break a tie when an old row's URL
 *                      collides with a fresh row's URL but the ids differ
 *                      (rare; happens when a tenant changes its source_id
 *                      generation but keeps the URL).
 * @param now           ISO 8601 UTC of today's build. Used for TTL math.
 * @param ttlDays       Days of staleness allowed; rows whose
 *                      `now − last_seen_at >= ttlDays` are dropped.
 *
 * Public for property tests in build-db.test.ts.
 */
export function planCarryForward(
  previousRows: ReadonlyArray<CarriedRow>,
  freshIds: ReadonlySet<string>,
  freshUrls: ReadonlySet<string>,
  now: string,
  ttlDays: number,
): CarryForwardResult {
  if (ttlDays < 1) {
    throw new Error(`planCarryForward: ttlDays must be >= 1, got ${ttlDays}`);
  }
  const carried: CarriedRow[] = [];
  let dropped = 0;
  for (const row of previousRows) {
    if (freshIds.has(row.id)) continue; // today's scrape will insert fresh
    if (freshUrls.has(row.url)) continue; // collision; today's row wins
    const age = daysSinceUtc(now, row.last_seen_at);
    if (age >= ttlDays) {
      dropped++;
      continue;
    }
    carried.push(row);
  }
  return { carried, dropped };
}

export function buildDb(input: BuildDbInput, dbPath = ":memory:"): BuildDbResult {
  const db = new Database(dbPath);
  db.exec(PAGE_SIZE_PRAGMA);
  db.exec(SCHEMA_DDL);
  db.exec(INDEX_DDL);

  const ttlDays = input.staleTtlDays ?? STALE_TTL_DAYS_DEFAULT;

  const allJobs: Job[] = [];
  for (const out of input.outputs) {
    for (const job of out.jobs) {
      allJobs.push(classifyJob(job));
    }
  }

  // Index today's fresh observations so we can decide what carries forward.
  // first_seen_at preservation lives here too — when a job we observed
  // before is observed again today, we keep the original first_seen_at
  // from the previous DB rather than overwriting it with today's value.
  const freshIds = new Set<string>();
  const freshUrls = new Set<string>();
  for (const j of allJobs) {
    freshIds.add(j.id);
    freshUrls.add(j.url);
  }

  const previousRows: ReadonlyArray<CarriedRow> =
    input.previousDbPath !== undefined ? readPreviousJobs(input.previousDbPath) : [];

  // Build a lookup so fresh inserts can preserve the original first_seen_at.
  const previousById = new Map<string, CarriedRow>();
  for (const row of previousRows) previousById.set(row.id, row);

  const carryPlan = planCarryForward(previousRows, freshIds, freshUrls, input.builtAt, ttlDays);

  const insertJob = db.prepare(`
    INSERT OR REPLACE INTO jobs (
      id, ats, tenant_slug, source_id, title, company, description_excerpt,
      level, level_rank, workplace_type, is_recruiter_post,
      location_text, location_country, location_region,
      compensation_min, compensation_max, compensation_currency,
      department, posted_at, updated_at, first_seen_at, last_seen_at, is_stale, url
    ) VALUES (
      $id, $ats, $tenant_slug, $source_id, $title, $company, $description_excerpt,
      $level, $level_rank, $workplace_type, $is_recruiter_post,
      $location_text, $location_country, $location_region,
      $compensation_min, $compensation_max, $compensation_currency,
      $department, $posted_at, $updated_at, $first_seen_at, $last_seen_at, $is_stale, $url
    )
  `);

  const seenUrls = new Set<string>();
  const insertFresh = db.transaction((jobs: ReadonlyArray<Job>) => {
    for (const j of jobs) {
      if (seenUrls.has(j.url)) continue;
      seenUrls.add(j.url);
      const carriedFirstSeen = previousById.get(j.id)?.first_seen_at;
      insertJob.run({
        $id: j.id,
        $ats: j.ats,
        $tenant_slug: j.tenant_slug,
        $source_id: j.source_id,
        $title: j.title,
        $company: j.company,
        $description_excerpt: j.description_excerpt ?? null,
        $level: j.level,
        $level_rank: j.level_rank,
        $workplace_type: j.workplace_type,
        $is_recruiter_post: j.is_recruiter_post ? 1 : 0,
        $location_text: j.location_text ?? null,
        $location_country: j.location_country ?? null,
        $location_region: j.location_region ?? null,
        $compensation_min: j.compensation_min ?? null,
        $compensation_max: j.compensation_max ?? null,
        $compensation_currency: j.compensation_currency ?? null,
        $department: j.department ?? null,
        $posted_at: j.posted_at ?? null,
        $updated_at: j.updated_at ?? null,
        $first_seen_at: carriedFirstSeen ?? j.first_seen_at,
        $last_seen_at: j.last_seen_at,
        $is_stale: 0,
        $url: j.url,
      });
    }
  });
  insertFresh(allJobs);

  const insertCarried = db.transaction((rows: ReadonlyArray<CarriedRow>) => {
    for (const r of rows) {
      if (seenUrls.has(r.url)) continue;
      seenUrls.add(r.url);
      insertJob.run({
        $id: r.id,
        $ats: r.ats,
        $tenant_slug: r.tenant_slug,
        $source_id: r.source_id,
        $title: r.title,
        $company: r.company,
        $description_excerpt: r.description_excerpt,
        $level: r.level,
        $level_rank: r.level_rank,
        $workplace_type: r.workplace_type,
        $is_recruiter_post: r.is_recruiter_post,
        $location_text: r.location_text,
        $location_country: r.location_country,
        $location_region: r.location_region,
        $compensation_min: r.compensation_min,
        $compensation_max: r.compensation_max,
        $compensation_currency: r.compensation_currency,
        $department: r.department,
        $posted_at: r.posted_at,
        $updated_at: r.updated_at,
        $first_seen_at: r.first_seen_at,
        $last_seen_at: r.last_seen_at,
        $is_stale: 1,
        $url: r.url,
      });
    }
  });
  insertCarried(carryPlan.carried);

  const insertTenant = db.prepare(`
    INSERT OR REPLACE INTO tenants (ats, slug, display_name, homepage_url, status, last_probed_at)
    VALUES ($ats, $slug, $display_name, $homepage_url, $status, $last_probed_at)
  `);
  const tenantTxn = db.transaction((tenants: ReadonlyArray<Tenant>) => {
    for (const t of tenants) {
      insertTenant.run({
        $ats: t.ats,
        $slug: t.slug,
        $display_name: t.display_name ?? null,
        $homepage_url: t.homepage_url ?? null,
        $status: t.status,
        $last_probed_at: t.last_probed_at,
      });
    }
  });
  tenantTxn(input.tenants);

  const totalRows = (db.query("SELECT COUNT(*) AS c FROM jobs").get() as { c: number }).c;
  const freshCount = (
    db.query("SELECT COUNT(*) AS c FROM jobs WHERE is_stale = 0").get() as { c: number }
  ).c;
  const staleCount = (
    db.query("SELECT COUNT(*) AS c FROM jobs WHERE is_stale = 1").get() as { c: number }
  ).c;
  const tenantsTotal = (db.query("SELECT COUNT(*) AS c FROM tenants").get() as { c: number }).c;
  const tenantsLive = (
    db.query("SELECT COUNT(*) AS c FROM tenants WHERE status='live'").get() as { c: number }
  ).c;
  const atsRows = db.query("SELECT ats, COUNT(*) AS c FROM jobs GROUP BY ats").all() as Array<{
    ats: string;
    c: number;
  }>;
  // Seed every known ATS to 0 so the manifest always carries the full key
  // set even when an ats has no rows; build it from ATS_IDS so adding new
  // entries doesn't require touching this site.
  const atsCounts: Record<ATSId, number> = Object.fromEntries(
    ATS_IDS.map((id) => [id, 0]),
  ) as Record<ATSId, number>;
  for (const row of atsRows) {
    if ((ATS_IDS as ReadonlyArray<string>).includes(row.ats)) {
      atsCounts[row.ats as ATSId] = row.c;
    }
  }

  db.prepare(
    "INSERT INTO crawls (build_short_sha, built_at, total_rows, notes) VALUES (?, ?, ?, ?)",
  ).run(input.buildShortSha, input.builtAt, totalRows, input.notes ?? null);

  db.exec(VACUUM_STMT);
  db.exec(FTS_OPTIMIZE_STMT);

  const manifest = ManifestSchema.parse({
    schema_version: SCHEMA_VERSION,
    built_at: input.builtAt,
    short_sha: input.buildShortSha,
    db_filename: `jobs.${input.buildShortSha}.sqlite`,
    total_rows: totalRows,
    ats_counts: atsCounts,
    tenants_total: tenantsTotal,
    tenants_live: tenantsLive,
    fresh_count: freshCount,
    stale_count: staleCount,
    stale_ttl_days: ttlDays,
  });

  return { db, manifest };
}
