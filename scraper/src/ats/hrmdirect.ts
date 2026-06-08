import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import { decodeHtmlEntities, plainText } from "../normalize.ts";
import { assertSafeSlug, dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

// HRMDirect (ClearCompany) hosted job boards. Every customer gets a public
// board at `{slug}.hrmdirect.com/employment/job-openings.php` that
// server-renders a single table of every open role — one `<tr ...
// data-req-id="{req}">` per posting, with columns for department, title (an
// anchor to `job-opening.php?req={req}&req_loc={loc}`), city and state. All
// the data the board shows lives in that one table, so a single GET per tenant
// covers it (no per-job detail fetch, no pagination on the boards observed).
//
// Tenant identity = slug (the board host is `{slug}.hrmdirect.com`), so no
// metadata is required — the same subdomain shape as bamboohr/breezy. The
// board carries no JSON or JSON-LD, so the table is parsed directly.
//
// The job IDENTITY is uniform across every tenant — `data-req-id` / `req_loc`
// and the `posTitle` anchor are always present, so title + canonical URL +
// source_id are always extracted. The optional DISPLAY columns are
// per-tenant-configurable: most boards expose semantic `departments` /
// `cities` / `state` cells (parsed here), but some relabel them as opaque
// `custSortN` columns whose meaning isn't knowable generically. For those,
// location/department are simply omitted (the row is still a valid Job) —
// graceful degradation rather than guessing. The seed list favours
// semantic-layout tenants so every seeded role carries a location.

const LISTING_PATH = "/employment/job-openings.php?search=true";

// Pull the text of the first `<td>` whose class list contains `cls` as a whole
// token. The token guard (not a bare prefix) stops a lookalike class like
// `statename` from being read as the `state` column. Decode entities BEFORE
// trimming so a `&nbsp;`-only cell (decodes to U+00A0, which trim() strips)
// collapses to empty rather than a stray space.
function cellText(chunk: string, cls: string): string {
  const m = new RegExp(`class="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"[^>]*>([^<]*)`, "i").exec(chunk);
  return m?.[1] ? decodeHtmlEntities(m[1]).trim() : "";
}

export interface ParseHrmDirectInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly html: string;
  readonly observedAt: string;
}

// Parse the board table into validated Jobs. Pure; deterministic; safe to
// fixture-replay and property-test. A row missing a usable (req, title) is
// skipped rather than failing the tenant.
export function parseHrmDirectListing(input: ParseHrmDirectInput): Job[] {
  const slug = input.tenant.slug;
  const host = `${slug}.hrmdirect.com`;
  // Each posting row is introduced by `data-req-id="{req}"`; splitting on it
  // gives one chunk per row (chunk[0] is the pre-table markup, skipped).
  const chunks = input.html.split('data-req-id="');
  const jobs: Job[] = [];
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i] ?? "";
    // Prefer the req + req_loc pair from the row's job-detail link (a posting
    // open in multiple locations renders one row per location). The pattern is
    // anchored to the `job-opening.php?…` URL so a stray `req=`/`req_loc=` in
    // some other cell's text can't hijack the id. Fall back to the bare
    // data-req-id with loc 0 when the link is absent.
    const link = /job-opening\.php\?req=(\d+)&req_loc=(\d+)/.exec(chunk);
    const reqId = link?.[1] ?? /^(\d+)/.exec(chunk)?.[1];
    if (!reqId) continue;
    const locId = link?.[2] ?? "0";
    // Capture the whole posTitle cell and strip tags so a title wrapped in
    // nested markup (`<a><span>Staff</span> Engineer</a>`) survives — a bare
    // `[^<]+` capture would lose everything after the first inner tag. Decode
    // entities BEFORE plainText: plainText emits each decoded entity as its own
    // text node joined by spaces, which would turn `R&amp;D` into `R & D`;
    // decoding first leaves a single text node that plainText passes through.
    const titleMatch = /class="(?:[^"]*\s)?posTitle(?:\s[^"]*)?"[^>]*>([\s\S]*?)<\/td>/i.exec(
      chunk,
    );
    const title = titleMatch?.[1] ? plainText(decodeHtmlEntities(titleMatch[1])) : "";
    if (!title) continue;
    const department = cellText(chunk, "departments");
    const city = cellText(chunk, "cities");
    const state = cellText(chunk, "state");
    const location = [city, state].filter((s) => s.length > 0).join(", ");
    const url = `https://${host}/employment/job-opening.php?req=${reqId}&req_loc=${locId}`;
    const candidate = buildJob({
      ats: "hrmdirect",
      tenant_slug: slug,
      company: input.company,
      source_id: `${reqId}-${locId}`,
      title,
      url,
      ...(location.length > 0 ? { location_text: location } : {}),
      // HRMDirect exposes no structured workplace field, so workplace_type is
      // inferred from the title/location text — a best-effort hint, not an
      // authoritative signal.
      workplace_hint: `${title} ${location}`,
      ...(department.length > 0 ? { department } : {}),
      is_recruiter_post: isRecruiterTitle(title),
      first_seen_at: input.observedAt,
      last_seen_at: input.observedAt,
    });
    const validated = JobSchema.safeParse(candidate);
    if (validated.success) jobs.push(validated.data);
  }
  return dedupeById(jobs);
}

export interface ScrapeHrmDirectOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
}

export interface ScrapeHrmDirectOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeHrmDirectTenant(
  opts: ScrapeHrmDirectOptions,
): Promise<ScrapeHrmDirectOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const host = `${opts.tenant.slug}.hrmdirect.com`;
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const res = await opts.client.request(`https://${host}${LISTING_PATH}`);
    const httpStatus = res.status;
    const html = await res.text();
    const jobs = parseHrmDirectListing({
      tenant: opts.tenant,
      company,
      html,
      observedAt: opts.observedAt,
    });
    return {
      jobs,
      result: {
        slug: opts.tenant.slug,
        status: "success",
        http_status: httpStatus,
        jobs_count: jobs.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
