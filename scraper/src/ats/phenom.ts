import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { buildJob } from "../build-job.ts";
import { type HttpClient, HttpError } from "../http.ts";
import {
  assertSafeSlug,
  dedupeById,
  errorToResult,
  isRecruiterTitle,
  isSafeFetchHost,
  vendorDateToIsoZ,
} from "./common.ts";

// Phenom ("Phenom People") personalised career sites. Each site server-renders
// the first page of its job search into a `phApp.ddo.eagerLoadRefineSearch`
// object embedded in the `/{locale}/search-results` HTML; re-fetching that page
// with `?from=N` advances the result window. We brace-match the object out of
// the inline script (no DOM, no JS execution) and read its job list +
// totalHits — the same public data the site shows every visitor.
//
// Tenant identity = (host, locale). Big Phenom customers serve from vanity
// domains (careers.{brand}.com), so the host is operator-seeded and guarded by
// isSafeFetchHost rather than anchored to a fixed suffix — the same posture as
// the jsonld harvester. The per-job URL is the canonical Candidate-Experience
// job card, which deep-links to the role (HTTP 200).

interface PhenomJob {
  jobSeqNo?: string | null;
  title?: string | null;
  location?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  postedDate?: string | null;
  descriptionTeaser?: string | null;
  department?: string | null;
}

// The SSR search page is hard-fixed at 10 results regardless of any size param,
// so pagination walks `?from=0,10,20,…`. The cap is a safety backstop —
// seeded tenants sit well under it; a tenant that exceeds it is reported with
// an explicit "capped" note rather than silently truncated.
const PAGE_SIZE = 10;
const MAX_PAGES = 120;
const DEFAULT_LOCALE = "us/en";

// Dotted public hostname only (no scheme, userinfo, port or path); combined
// with isSafeFetchHost this bounds a tenant-supplied host to a real careers
// domain and closes the SSRF surface on the vanity-domain seed channel.
const PHENOM_HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+[a-z]{2,}$/i;
// `{country}/{lang}` path segment — lowercase letters and a single slash only,
// so it cannot inject extra path segments into the URL.
const PHENOM_LOCALE_RE = /^[a-z]{2,8}\/[a-z]{2}$/;

export interface PhenomSearchPage {
  readonly jobs: PhenomJob[];
  readonly totalHits: number;
}

// Find the index just past the `}` that closes the JSON object beginning at
// `start`, honouring string literals + escapes so braces inside strings don't
// throw off the depth count. Returns -1 if the object never closes.
function balancedObjectEnd(html: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let k = start; k < html.length; k++) {
    const c = html[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return k + 1;
  }
  return -1;
}

// Brace-match and parse the `eagerLoadRefineSearch` object embedded in a
// Phenom search-results page. Pure; returns null when the block is absent or
// unparseable (e.g. a tenant behind bot protection serving a challenge page).
export function parsePhenomSearchPage(html: string): PhenomSearchPage | null {
  const key = '"eagerLoadRefineSearch":';
  const anchor = html.indexOf(key);
  if (anchor < 0) return null;
  const start = html.indexOf("{", anchor + key.length);
  if (start < 0) return null;
  const end = balancedObjectEnd(html, start);
  if (end < 0) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(html.slice(start, end));
  } catch {
    return null;
  }
  const o = obj as { totalHits?: number; data?: { jobs?: PhenomJob[] } };
  const jobs = Array.isArray(o.data?.jobs) ? (o.data?.jobs as PhenomJob[]) : [];
  const totalHits = typeof o.totalHits === "number" ? o.totalHits : jobs.length;
  return { jobs, totalHits };
}

export interface PhenomJobToJobInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly host: string;
  readonly locale: string;
  readonly observedAt: string;
  readonly job: PhenomJob;
}

export function phenomJobToJob(input: PhenomJobToJobInput): Job | null {
  const j = input.job;
  if (!j.jobSeqNo || !j.title) return null;
  // Canonical job-card URL. `/{locale}/job/{jobSeqNo}` renders the specific
  // requisition (HTTP 200); the jobSeqNo is Phenom's stable per-posting id.
  const url = `https://${input.host}/${input.locale}/job/${j.jobSeqNo}`;
  const location =
    typeof j.location === "string" && j.location.trim().length > 0
      ? j.location.trim()
      : [j.city, j.state, j.country]
          .filter((s) => typeof s === "string" && s.length > 0)
          .join(", ");
  const department =
    typeof j.department === "string" && j.department.trim().length > 0
      ? j.department.trim()
      : undefined;
  // postedDate is a full ISO timestamp; drop it if it would post-date the scrape
  // (the schema requires posted_at <= last_seen_at) rather than failing the row.
  const postedRaw = vendorDateToIsoZ(j.postedDate);
  const postedAt = postedRaw && postedRaw <= input.observedAt ? postedRaw : undefined;

  const candidate = buildJob({
    ats: "phenom",
    tenant_slug: input.tenant.slug,
    company: input.company,
    source_id: j.jobSeqNo,
    title: j.title,
    url,
    // The teaser is short prose but may carry entities/markup — run it through
    // the HTML path so it is stripped and control-char-safe for the excerpt.
    ...(j.descriptionTeaser ? { description_html: j.descriptionTeaser } : {}),
    ...(location.length > 0 ? { location_text: location } : {}),
    workplace_hint: `${j.title} ${location}`,
    ...(department ? { department } : {}),
    ...(postedAt ? { posted_at: postedAt } : {}),
    is_recruiter_post: isRecruiterTitle(j.title),
    first_seen_at: input.observedAt,
    last_seen_at: input.observedAt,
  });
  const validated = JobSchema.safeParse(candidate);
  return validated.success ? validated.data : null;
}

export interface ScrapePhenomOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly host: string;
  readonly locale: string;
}

export interface ScrapePhenomOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

function assertPhenomHost(host: string): void {
  let parsed: URL;
  try {
    parsed = new URL(`https://${host}`);
  } catch {
    throw new HttpError("permanent", `phenom host rejected: ${JSON.stringify(host)}`);
  }
  if (
    !PHENOM_HOST_RE.test(host) ||
    parsed.hostname !== host.toLowerCase() ||
    !isSafeFetchHost(parsed)
  ) {
    throw new HttpError("permanent", `phenom host rejected: ${JSON.stringify(host)}`);
  }
}

export async function scrapePhenomTenant(opts: ScrapePhenomOptions): Promise<ScrapePhenomOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    assertPhenomHost(opts.host);
    if (!PHENOM_LOCALE_RE.test(opts.locale)) {
      throw new HttpError("permanent", `phenom locale rejected: ${JSON.stringify(opts.locale)}`);
    }
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const jobs: Job[] = [];
    let httpStatus = 0;
    let total = Number.POSITIVE_INFINITY;

    for (let page = 0; page < MAX_PAGES; page++) {
      const from = page * PAGE_SIZE;
      if (from >= total) break;
      const url = `https://${opts.host}/${opts.locale}/search-results?from=${from}&s=1`;
      const res = await opts.client.request(url);
      httpStatus = res.status;
      const parsed = parsePhenomSearchPage(await res.text());
      if (!parsed) break;
      total = parsed.totalHits;
      if (parsed.jobs.length === 0) break;
      for (const j of parsed.jobs) {
        const job = phenomJobToJob({
          tenant: opts.tenant,
          company,
          host: opts.host,
          locale: opts.locale,
          observedAt: opts.observedAt,
          job: j,
        });
        if (job) jobs.push(job);
      }
      if (parsed.jobs.length < PAGE_SIZE) break;
    }

    const deduped = dedupeById(jobs);
    const capped = Number.isFinite(total) && total > MAX_PAGES * PAGE_SIZE;
    return {
      jobs: deduped,
      result: {
        slug: opts.tenant.slug,
        status: "success",
        http_status: httpStatus,
        ...(capped ? { error: `capped at ${MAX_PAGES * PAGE_SIZE} of ${total} hits` } : {}),
        jobs_count: deduped.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}

export { DEFAULT_LOCALE as PHENOM_DEFAULT_LOCALE };
