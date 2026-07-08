import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { buildJob } from "../build-job.ts";
import { type HttpClient, HttpError } from "../http.ts";
import { plainText } from "../normalize.ts";
import {
  assertSafeSlug,
  dedupeById,
  errorToResult,
  isRecruiterTitle,
  isSafeFetchHost,
} from "./common.ts";

// TalentBrew (Radancy) per-brand career sites. Each brand runs on its own
// vanity host (`jobs.disneycareers.com`, `jobs.boeing.com`, `jobs.comcast.com`)
// whose public job listing is server-rendered HTML at `{host}/search-jobs`,
// paginated by `?p=N` (N is 1-based). There is no JSON API and no shared host,
// so tenant identity is the vanity host itself, carried as mandatory
// `metadata.host` and SSRF-guarded like phenom's vanity domains.
//
// The listing renders in several markup skins (a table skin, a list skin, a
// ul/li skin), and their column classes differ. The one invariant across every
// skin is the job anchor: an opening `<a>` carrying both an `href="/job/…"` and
// a `data-job-id="…"`. The parser keys off that anchor for the title, id and
// apply URL, then reads the optional location / posted-date / brand columns by
// class from the row block that follows each anchor — so it is skin-agnostic.
// Everything the index needs lives on the listing, so jobs are built from it
// alone (no per-job detail fetch).
//
// `data-total-results="N"` on every page is the open-role count; it plus the
// zero-anchor page past the end bound the pagination walk.

// 15 roles per page × 500 pages = 7,500 roles — a backstop against a
// pathological brand, not routine truncation (the largest verified seed runs
// ~1,378 roles). When the cap does bite, the truncation is surfaced on the
// TenantResult rather than silently dropped.
const MAX_PAGES = 500;
const PAGE_SIZE = 15;

// Dotted public hostname only (no scheme, userinfo, port or path). Combined
// with isSafeFetchHost and the hostname round-trip below, this bounds a
// tenant-supplied host to a real careers domain and closes the SSRF surface on
// the vanity-domain seed channel.
const TALENTBREW_HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+[a-z]{2,}$/i;

function assertTalentbrewHost(host: string): void {
  let parsed: URL;
  try {
    parsed = new URL(`https://${host}`);
  } catch {
    throw new HttpError("permanent", `talentbrew host rejected: ${JSON.stringify(host)}`);
  }
  // The hostname round-trip rejects a userinfo-masked host
  // (`good.com@evil.com` parses to hostname `evil.com`) and a path-injected
  // host (`good.com/x` parses to hostname `good.com`), either of which would
  // otherwise smuggle a request past the label regex.
  if (
    !TALENTBREW_HOST_RE.test(host) ||
    parsed.hostname !== host.toLowerCase() ||
    !isSafeFetchHost(parsed)
  ) {
    throw new HttpError("permanent", `talentbrew host rejected: ${JSON.stringify(host)}`);
  }
}

const MONTHS: Readonly<Record<string, string>> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

// Normalize a listing-cell date to a UTC-midnight ISO timestamp. Two skins,
// two formats: `Mon. DD, YYYY` (e.g. `Jul. 07, 2026`) and `MM/DD/YYYY` (e.g.
// `07/08/2026`). Reject anything that doesn't round-trip through Date (month
// 13, day 45, …) and anything in the future of the observation — JobSchema
// enforces `posted_at <= last_seen_at`, so a bogus or future date costs the
// field, not the whole row. Returns undefined for any unrecognised shape.
export function normalizeTalentbrewDate(
  raw: string | undefined,
  observedAt: string,
): string | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  let yyyy: string | undefined;
  let mm: string | undefined;
  let dd: string | undefined;
  const worded = /^([A-Za-z]{3})\.?\s+(\d{1,2}),\s+(\d{4})$/.exec(text);
  const numeric = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (worded) {
    yyyy = worded[3];
    mm = worded[1] !== undefined ? MONTHS[worded[1].toLowerCase()] : undefined;
    dd = worded[2]?.padStart(2, "0");
  } else if (numeric) {
    yyyy = numeric[3];
    mm = numeric[1]?.padStart(2, "0");
    dd = numeric[2]?.padStart(2, "0");
  }
  if (yyyy === undefined || mm === undefined || dd === undefined) return undefined;
  const iso = `${yyyy}-${mm}-${dd}T00:00:00.000Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.toISOString() !== iso) return undefined;
  return iso <= observedAt ? iso : undefined;
}

const TITLE_H2_RE = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i;
const TITLE_SPAN_RE =
  /<span[^>]*class="[^"]*search-results__job-title[^"]*"[^>]*>([\s\S]*?)<\/span>/i;

// Extract the visible job title from an anchor's inner markup. The table and
// ul/li skins wrap the title in an `<h2>` and the list skin in a
// `search-results__job-title` span; some skins also nest the location/date
// columns *inside* the anchor, so keying off the title element (rather than
// stripping the whole anchor) keeps those columns out of the title. Falls back
// to the full inner text when neither wrapper is present. Decodes entities
// (`&amp;` → `&`) and collapses whitespace. Pure and total — never throws,
// never returns markup.
export function stripTalentbrewTitle(innerHtml: string): string {
  const h2 = TITLE_H2_RE.exec(innerHtml)?.[1];
  if (h2 !== undefined) return plainText(h2);
  const span = TITLE_SPAN_RE.exec(innerHtml)?.[1];
  if (span !== undefined) return plainText(span);
  return plainText(innerHtml);
}

// Location column: the row's `job-location` span (table / ul-li skins) or the
// `search-results__job-info location` span (list skin).
const LOCATION_RE =
  /<span[^>]*class="(?:job-location|search-results__job-info location)[^"]*"[^>]*>([\s\S]*?)<\/span>/i;
// Posted-date column: `job-date-posted` (table / ul-li skins) or
// `search-results__job-info date` (list skin).
const DATE_RE =
  /<span[^>]*class="(?:job-date-posted|search-results__job-info date)[^"]*"[^>]*>([\s\S]*?)<\/span>/i;
// Brand column: only some skins render it. Mapped into the Job's department
// slot — it names the operating sub-brand (`Walt Disney World Resort`), which
// is the closest thing the slim schema carries.
const BRAND_RE = /<span[^>]*class="job-brand[^"]*"[^>]*>([\s\S]*?)<\/span>/i;

function cellText(block: string, re: RegExp): string | undefined {
  const inner = re.exec(block)?.[1];
  if (inner === undefined) return undefined;
  const text = plainText(inner);
  return text.length > 0 ? text : undefined;
}

interface JobAnchor {
  readonly start: number;
  readonly tagEnd: number;
  readonly href: string;
  readonly jobId: string;
}

// Every opening `<a>` tag; order-independent attribute reads pick out the job
// anchors (those carrying both an `/job/…` href and a numeric data-job-id).
const ANCHOR_RE = /<a\b[^>]*>/gi;
const HREF_RE = /href="(\/job\/[^"]*)"/i;
const JOB_ID_RE = /data-job-id="(\d+)"/i;
const TOTAL_RE = /data-total-results="(\d+)"/i;

function findJobAnchors(html: string): JobAnchor[] {
  const anchors: JobAnchor[] = [];
  ANCHOR_RE.lastIndex = 0;
  for (let m = ANCHOR_RE.exec(html); m !== null; m = ANCHOR_RE.exec(html)) {
    const tag = m[0];
    const href = HREF_RE.exec(tag)?.[1];
    const jobId = JOB_ID_RE.exec(tag)?.[1];
    if (href === undefined || jobId === undefined) continue;
    anchors.push({ start: m.index, tagEnd: m.index + tag.length, href, jobId });
  }
  return anchors;
}

export interface ParseTalentbrewInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly host: string;
  readonly html: string;
  readonly observedAt: string;
}

export interface TalentbrewParsePage {
  readonly jobs: Job[];
  // The `data-total-results` count when the page carries the marker.
  readonly total: number | undefined;
  // How many job anchors the page rendered — zero is the past-the-end
  // pagination-termination sentinel.
  readonly anchorCount: number;
}

// Parse one `/search-jobs` page into validated Jobs. Pure; deterministic; safe
// to fixture-replay and property-test. A row whose title strips to empty is
// skipped (defensive). Jobs are deduped by data-job-id within the page.
export function parseTalentbrewPage(input: ParseTalentbrewInput): TalentbrewParsePage {
  const { html, host } = input;
  const anchors = findJobAnchors(html);
  const totalMatch = TOTAL_RE.exec(html)?.[1];
  const total = totalMatch !== undefined ? Number(totalMatch) : undefined;
  const jobs: Job[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    if (anchor === undefined) continue;
    // Row block = this anchor's start up to the next job anchor (or EOF for
    // the last). The title comes from the anchor's own inner markup; the
    // optional columns are read from the block that follows it.
    const blockEnd = anchors[i + 1]?.start ?? html.length;
    const closeIdx = html.indexOf("</a>", anchor.tagEnd);
    const innerHtml =
      closeIdx >= 0 && closeIdx < blockEnd ? html.slice(anchor.tagEnd, closeIdx) : "";
    const title = stripTalentbrewTitle(innerHtml);
    if (title.length === 0) continue;
    const block = html.slice(anchor.tagEnd, blockEnd);
    const location = cellText(block, LOCATION_RE);
    const postedAt = normalizeTalentbrewDate(cellText(block, DATE_RE), input.observedAt);
    const brand = cellText(block, BRAND_RE);
    const candidate = buildJob({
      ats: "talentbrew",
      tenant_slug: input.tenant.slug,
      company: input.company,
      source_id: anchor.jobId,
      title,
      // Absolute-ize the site-relative href against the tenant host.
      url: `https://${host}${anchor.href}`,
      ...(location !== undefined ? { location_text: location } : {}),
      // TalentBrew exposes no structured workplace field, so workplace_type is
      // inferred from the title/location text — a best-effort hint.
      workplace_hint: `${title} ${location ?? ""}`,
      ...(brand !== undefined ? { department: brand } : {}),
      ...(postedAt !== undefined ? { posted_at: postedAt } : {}),
      is_recruiter_post: isRecruiterTitle(title),
      first_seen_at: input.observedAt,
      last_seen_at: input.observedAt,
    });
    const validated = JobSchema.safeParse(candidate);
    if (validated.success) jobs.push(validated.data);
  }
  return { jobs: dedupeById(jobs), total, anchorCount: anchors.length };
}

export interface ScrapeTalentbrewOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly host: string;
  readonly maxPages?: number;
}

export interface ScrapeTalentbrewOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeTalentbrewTenant(
  opts: ScrapeTalentbrewOptions,
): Promise<ScrapeTalentbrewOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    assertTalentbrewHost(opts.host);
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const maxPages = opts.maxPages ?? MAX_PAGES;
    const jobs: Job[] = [];
    const seen = new Set<string>();
    let httpStatus = 0;
    let total: number | undefined;
    let capped = false;

    // Pages are 1-based (`?p=1` is page one). Stop on the first of: a page with
    // zero job anchors (past the end), the collected count reaching the
    // announced total, or the hard page cap.
    let page = 0;
    for (;;) {
      page += 1;
      if (page > maxPages) {
        capped = true;
        break;
      }
      const res = await opts.client.request(`https://${opts.host}/search-jobs?p=${page}`);
      httpStatus = res.status;
      const parsed = parseTalentbrewPage({
        tenant: opts.tenant,
        company,
        host: opts.host,
        html: await res.text(),
        observedAt: opts.observedAt,
      });
      if (page === 1) total = parsed.total;
      if (parsed.anchorCount === 0) break;
      for (const job of parsed.jobs) {
        if (seen.has(job.source_id)) continue;
        seen.add(job.source_id);
        jobs.push(job);
      }
      if (total !== undefined && jobs.length >= total) break;
    }

    const deduped = dedupeById(jobs);
    return {
      jobs: deduped,
      result: {
        slug: opts.tenant.slug,
        status: "success",
        http_status: httpStatus,
        ...(capped ? { error: `capped at ${maxPages * PAGE_SIZE} of ${total ?? "?"} roles` } : {}),
        jobs_count: deduped.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
