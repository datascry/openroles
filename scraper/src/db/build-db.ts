import { Database } from "bun:sqlite";
import {
  ATS_IDS,
  type ATSId,
  classifyLevel,
  classifyRecruiter,
  type Job,
  levelRank,
  type Manifest,
  ManifestSchema,
  SCHEMA_VERSION,
  type ScrapeOutput,
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
  return {
    ...job,
    level,
    level_rank: levelRank(level),
    is_recruiter_post: isRecruiter,
  };
}

export function buildDb(input: BuildDbInput, dbPath = ":memory:"): BuildDbResult {
  const db = new Database(dbPath);
  db.exec(PAGE_SIZE_PRAGMA);
  db.exec(SCHEMA_DDL);
  db.exec(INDEX_DDL);

  const allJobs: Job[] = [];
  for (const out of input.outputs) {
    for (const job of out.jobs) {
      allJobs.push(classifyJob(job));
    }
  }

  const insertJob = db.prepare(`
    INSERT OR REPLACE INTO jobs (
      id, ats, tenant_slug, source_id, title, company, description_excerpt,
      level, level_rank, workplace_type, is_recruiter_post,
      location_text, location_country, location_region,
      compensation_min, compensation_max, compensation_currency,
      department, posted_at, updated_at, first_seen_at, last_seen_at, url
    ) VALUES (
      $id, $ats, $tenant_slug, $source_id, $title, $company, $description_excerpt,
      $level, $level_rank, $workplace_type, $is_recruiter_post,
      $location_text, $location_country, $location_region,
      $compensation_min, $compensation_max, $compensation_currency,
      $department, $posted_at, $updated_at, $first_seen_at, $last_seen_at, $url
    )
  `);

  const seenUrls = new Set<string>();
  const insertMany = db.transaction((jobs: ReadonlyArray<Job>) => {
    for (const j of jobs) {
      if (seenUrls.has(j.url)) continue;
      seenUrls.add(j.url);
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
        $first_seen_at: j.first_seen_at,
        $last_seen_at: j.last_seen_at,
        $url: j.url,
      });
    }
  });
  insertMany(allJobs);

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
  const tenantsTotal = (db.query("SELECT COUNT(*) AS c FROM tenants").get() as { c: number }).c;
  const tenantsLive = (
    db.query("SELECT COUNT(*) AS c FROM tenants WHERE status='live'").get() as { c: number }
  ).c;
  const atsRows = db.query("SELECT ats, COUNT(*) AS c FROM jobs GROUP BY ats").all() as Array<{
    ats: string;
    c: number;
  }>;
  const atsCounts: Record<ATSId, number> = {
    greenhouse: 0,
    lever: 0,
    ashby: 0,
    bamboohr: 0,
    workday: 0,
    icims: 0,
  };
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
  });

  return { db, manifest };
}
