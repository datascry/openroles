import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import { decodeHtmlEntities, plainText } from "../normalize.ts";
import { assertSafeSlug, dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

// CareerPlug hosted job boards. Every customer gets a public board at
// `{slug}.careerplug.com/jobs` that server-renders one card per posting:
// an `<a href="/jobs/{id}">` wrapping a `job-title` div (the title inside a
// `<span class="name">`), a `job-location` div and a `job-post-date` div.
// The board paginates at ~30 cards per page via `?page=N`, and a
// `.pagination` nav on every page announces the last page number — so the
// walk is: fetch page 1, read the last page from its nav (no nav = single
// page), then fetch the remaining pages sequentially.
//
// Tenant identity = slug (the board host is `{slug}.careerplug.com`), so no
// metadata is required — the same subdomain shape as bamboohr/breezy.
// Franchise brands commonly run one subdomain per location, so slugs are
// plentiful and often hyphenated.
//
// Everything the index needs lives on the card (title, id, location, post
// date), so jobs are built from the listing alone — no per-job detail fetch
// (the detail URL 302s straight into the application flow anyway). The
// location and post-date columns degrade gracefully: a card missing either
// still yields a valid Job with the field omitted rather than guessed.

// Hard ceiling on the pagination walk: 200 pages ≈ 6,000 cards. The largest
// board observed live (a national gym franchise) runs ~113 pages, so the cap
// only bites on pathological boards; when it does, the truncation is
// surfaced on the TenantResult rather than silently dropped.
const DEFAULT_MAX_PAGES = 200;

// Card locations render as `ST-City-ZIP` (`VT-South Burlington-05403`).
// Rewrite that shape to the conventional `City, ST` the location splitter
// understands; the greedy middle group keeps hyphenated cities
// (`PA-Wilkes-Barre-18702`) intact and trailing padding inside the city is
// trimmed. Any other shape is per-tenant free text and is kept verbatim.
function normalizeCardLocation(raw: string): string {
  const m = /^([A-Z]{2})-(.+)-(\d{5})(?:-\d{4})?$/.exec(raw);
  const state = m?.[1];
  const city = m?.[2]?.trim();
  return state !== undefined && city !== undefined && city.length > 0 ? `${city}, ${state}` : raw;
}

// Card post dates render as `MM-DD-YY`. Expand to a UTC midnight ISO
// timestamp; reject anything that doesn't round-trip through Date (month 13,
// day 45, …) and anything in the future of the observation — JobSchema
// enforces `posted_at <= last_seen_at`, and a bogus future date should cost
// the field, not the job.
function cardPostedAt(raw: string, observedAt: string): string | undefined {
  const m = /^(\d{2})-(\d{2})-(\d{2})$/.exec(raw);
  const [, mm, dd, yy] = m ?? [];
  if (mm === undefined || dd === undefined || yy === undefined) return undefined;
  const iso = `20${yy}-${mm}-${dd}T00:00:00.000Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.toISOString() !== iso) return undefined;
  return iso <= observedAt ? iso : undefined;
}

// Pull the labelled text of a card column (`job-location` / `job-post-date`):
// the visible value sits between the mobile-only label span and the next tag.
// Decode entities before trimming so a whitespace-entity-only cell collapses
// to empty (→ omitted) rather than a stray space.
function cardColumn(chunk: string, cls: string): string {
  const m = new RegExp(`class="${cls}[^"]*"[^>]*>[\\s\\S]*?</span>([^<]*)`, "i").exec(chunk);
  return m?.[1] ? decodeHtmlEntities(m[1]).trim() : "";
}

// Pull the inner markup of the `.pagination` nav (a single-page board
// renders none). The element closes with `</div>` (or `</nav>` on a
// variant renderer); the nav itself contains no nested divs, so the first
// closer ends it.
function paginationNav(html: string): string | undefined {
  return /class="pagination"[^>]*>([\s\S]*?)<\/(?:div|nav)>/.exec(html)?.[1];
}

// Read the last page number the pagination nav announces. Each page entry
// carries both a `Go to page: N` aria-label and (except the current page, a
// bare `<em>`) a `?page=N` href; the largest N across both is the last
// page. Large boards window the numbered links behind a gap ellipsis but
// still render the tail last-page links, so the max holds there too —
// and scanning the aria-labels keeps the answer right on the final page,
// where every href points backwards.
export function careerplugLastPage(html: string): number {
  const nav = paginationNav(html);
  if (!nav) return 1;
  let last = 1;
  const re = /(?:[?&]page=|Go to page: )(\d+)/g;
  for (let m = re.exec(nav); m !== null; m = re.exec(nav)) {
    const n = Number(m[1]);
    if (n > last) last = n;
  }
  return last;
}

// True when the page's pagination nav carries a live "next" link — an
// `<a class="next_page">` anchor. On the final page the renderer demotes it
// to a disabled `<span>`, and defensively an anchor whose class also says
// `disabled` counts as dead too. This is the safety net behind
// careerplugLastPage: a variant renderer that windows the nav WITHOUT the
// tail numbered link would make the announced max undercount, and only the
// live next link betrays that more pages follow.
function hasLiveNextLink(html: string): boolean {
  const nav = paginationNav(html);
  if (!nav) return false;
  const cls = /<a[^>]*class="([^"]*\bnext_page\b[^"]*)"/i.exec(nav)?.[1];
  return cls !== undefined && !/\bdisabled\b/.test(cls);
}

export interface ParseCareerplugInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly html: string;
  readonly observedAt: string;
}

// Parse one listing page into validated Jobs. Pure; deterministic; safe to
// fixture-replay and property-test. A card missing a usable (id, title) is
// skipped rather than failing the tenant.
export function parseCareerplugListing(input: ParseCareerplugInput): Job[] {
  const slug = input.tenant.slug;
  const host = `${slug}.careerplug.com`;
  // Every card is introduced by its detail-link `href="/jobs/{id}"`;
  // splitting on it gives one chunk per card (chunk[0] is the pre-table
  // markup, skipped). Pagination links are `/jobs?page=N`, so they never
  // produce a chunk.
  const chunks = input.html.split('href="/jobs/');
  const jobs: Job[] = [];
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i] ?? "";
    const id = /^(\d+)"/.exec(chunk)?.[1];
    if (!id) continue;
    // Capture the whole job-title div and strip tags so a title wrapped in
    // nested markup survives. Decode entities BEFORE plainText: plainText
    // emits each decoded entity as its own text node joined by spaces, which
    // would turn `Desk &amp; Sales` into `Desk & Sales` with doubled spacing;
    // decoding first leaves a single text node it passes through.
    const titleMatch = /class="job-title[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(chunk);
    const title = titleMatch?.[1] ? plainText(decodeHtmlEntities(titleMatch[1])) : "";
    if (!title) continue;
    const location = normalizeCardLocation(cardColumn(chunk, "job-location"));
    const postedAt = cardPostedAt(cardColumn(chunk, "job-post-date"), input.observedAt);
    const candidate = buildJob({
      ats: "careerplug",
      tenant_slug: slug,
      company: input.company,
      source_id: id,
      title,
      url: `https://${host}/jobs/${id}`,
      ...(location.length > 0 ? { location_text: location } : {}),
      // CareerPlug exposes no structured workplace field, so workplace_type
      // is inferred from the title/location text — a best-effort hint, not
      // an authoritative signal.
      workplace_hint: `${title} ${location}`,
      ...(postedAt !== undefined ? { posted_at: postedAt } : {}),
      is_recruiter_post: isRecruiterTitle(title),
      first_seen_at: input.observedAt,
      last_seen_at: input.observedAt,
    });
    const validated = JobSchema.safeParse(candidate);
    if (validated.success) jobs.push(validated.data);
  }
  return dedupeById(jobs);
}

export interface ScrapeCareerplugOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly maxPages?: number;
}

export interface ScrapeCareerplugOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeCareerplugTenant(
  opts: ScrapeCareerplugOptions,
): Promise<ScrapeCareerplugOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const host = `${opts.tenant.slug}.careerplug.com`;
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
    const res = await opts.client.request(`https://${host}/jobs`);
    const httpStatus = res.status;
    const html = await res.text();
    const parseInput = { tenant: opts.tenant, company, observedAt: opts.observedAt };
    const jobs = parseCareerplugListing({ ...parseInput, html });
    const announced = careerplugLastPage(html);
    let page = 1;
    let lastHtml = html;
    // Walk the pages the nav announces...
    while (page < Math.min(announced, maxPages)) {
      page += 1;
      const pageRes = await opts.client.request(`https://${host}/jobs?page=${page}`);
      lastHtml = await pageRes.text();
      jobs.push(...parseCareerplugListing({ ...parseInput, html: lastHtml }));
    }
    // ...then keep following any live next link the final fetched page still
    // shows. On the standard renderer this loop never runs (the announced
    // max IS the last page and its next link is disabled), but a variant
    // that windows the nav without the tail numbered link would otherwise
    // silently truncate the board.
    let cappedAtLiveNext = false;
    while (hasLiveNextLink(lastHtml)) {
      if (page >= maxPages) {
        cappedAtLiveNext = true;
        break;
      }
      page += 1;
      const pageRes = await opts.client.request(`https://${host}/jobs?page=${page}`);
      lastHtml = await pageRes.text();
      jobs.push(...parseCareerplugListing({ ...parseInput, html: lastHtml }));
    }
    const deduped = dedupeById(jobs);
    // Truncated either because the nav announced more pages than the cap, or
    // because the cap halted the walk while a live next link remained.
    const capped = announced > maxPages || cappedAtLiveNext;
    return {
      jobs: deduped,
      result: {
        slug: opts.tenant.slug,
        status: "success",
        http_status: httpStatus,
        ...(capped ? { error: `capped at ${maxPages} pages before the end of the board` } : {}),
        jobs_count: deduped.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
