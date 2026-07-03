import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import { decodeHtmlEntities, plainText } from "../normalize.ts";
import { assertSafeSlug, dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

// Frontline AppliTrack K-12 recruiting boards. Districts share the host
// `www.applitrack.com`; each gets a classic server-rendered ASP board under
// `/{district}/onlineapp/`. The `jobpostings/Output.asp?all=1` endpoint
// returns a JavaScript document — a stream of `document.write('…')` calls
// whose single-quoted payloads, concatenated in file order, form the full
// HTML for every open posting. One GET per tenant covers the whole board
// (no pagination, no per-job detail fetch).
//
// The write boundaries are flush-sized, NOT posting-sized: a posting's
// markup routinely spans two or more consecutive writes, and a single write
// can carry several postings. The parser therefore unescapes and joins all
// payloads first, then extracts postings from the reassembled HTML. A write
// that isn't a well-formed string literal simply never matches the payload
// pattern and is skipped — malformed chunks degrade coverage, never the
// tenant.
//
// Reassembled, each posting is a `<ul class='postingsList' id='p{ID}_'>`
// block: a title table whose `<td id='wrapword'>` cell holds the title,
// followed by labelled `<li>` fields (`Date Posted:`, `Location:`, …), the
// collapsed description, and share links carrying `AppliTrackJobId={ID}`.
// The block id is the AppliTrackJobId — the same id the canonical public
// posting view accepts at
// `https://www.applitrack.com/{district}/onlineapp/jobpostings/view.asp?AppliTrackJobId={ID}`.
//
// Tenant identity = the district path slug (lowercase alnum, occasionally
// hyphenated — the shared SAFE_SLUG shape). Some districts also resolve on
// regional hosts (`phl.applitrack.com`); `www` serves them all, so it is
// treated as canonical here.
//
// The description sits in a `<span id='DescriptionText{ID}_'>` wrapper full
// of nested CKEditor spans — reliably delimiting it needs balanced-tag
// parsing, and the slim index only queries title/location, so the
// description is intentionally not extracted.

const HOST = "www.applitrack.com";

// Pull every well-formed single-quoted `document.write('…')` payload,
// unescape the JS string escapes the ASP emitter uses (\' \" \\ \/ plus
// whitespace escapes), and join them into one HTML document. Non-literal
// writes (`document.write(unescape(…))`, concatenations, unterminated
// strings) don't match and are skipped.
const WRITE_PAYLOAD = /document\.write\('((?:\\.|[^'\\])*)'\)/g;

function reassembleHtml(body: string): string {
  const parts: string[] = [];
  for (const m of body.matchAll(WRITE_PAYLOAD)) {
    const raw = m[1] ?? "";
    // Single left-to-right pass so an escaped backslash (`\\`) can never be
    // re-read as the opener of a following `\n`-style escape.
    parts.push(
      raw.replace(/\\(.)/gs, (_, c: string) =>
        c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c,
      ),
    );
  }
  return parts.join("");
}

// Extract the text following a `{label}</span>` field header, e.g.
// `Date Posted:</span><br/>&nbsp;&nbsp;<span class="normal">6/16/2026</span>`.
// Both quote styles appear on the value span (`class="normal"` and
// `class='normal'`), sometimes with surrounding whitespace/entity filler.
function fieldText(chunk: string, label: string): string {
  const m = new RegExp(
    `${label}:\\s*</span>(?:<br/>|&nbsp;|\\s)*<span class=["']normal["'][^>]*>([^<]*)`,
    "i",
  ).exec(chunk);
  return m?.[1] ? decodeHtmlEntities(m[1]).trim() : "";
}

// AppliTrack renders `Date Posted` as a US-style M/D/YYYY string (month and
// day unpadded). Returns the UTC-midnight ISO instant, or undefined when the
// text isn't a clean calendar date ("until filled", "ongoing") or when the
// date lies after `observedAt` — a posted_at in the future of its own
// observation is vendor noise, not a fact worth persisting.
function parsePostedAt(text: string, observedAt: string): string | undefined {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (!m) return undefined;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  const epoch = Date.UTC(year, month - 1, day);
  const d = new Date(epoch);
  // Round-trip guard: Date.UTC silently rolls over out-of-range components
  // (13/40/2026 becomes a real date in the next year), so reject any parse
  // whose components changed.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return undefined;
  }
  if (epoch > Date.parse(observedAt)) return undefined;
  return d.toISOString();
}

export interface ParseApplitrackInput {
  readonly tenant: TenantInput;
  readonly company: string;
  // The raw Output.asp response — a JavaScript document, not HTML.
  readonly body: string;
  readonly observedAt: string;
}

// Parse the reassembled board into validated Jobs. Pure; deterministic; safe
// to fixture-replay and property-test. A posting block missing a usable
// title is skipped rather than failing the tenant.
export function parseApplitrackListing(input: ParseApplitrackInput): Job[] {
  const slug = input.tenant.slug;
  const html = reassembleHtml(input.body);
  // Each posting opens with `<ul class='postingsList' id='p{ID}_'>`; the id
  // is the AppliTrackJobId. Splitting on the open tag yields (id, body)
  // pairs; index 0 is the pre-list markup, skipped.
  const chunks = html.split(/<ul class=['"]postingsList['"] id=['"]p(\d+)_['"]>/);
  const jobs: Job[] = [];
  for (let i = 1; i < chunks.length; i += 2) {
    const sourceId = chunks[i] ?? "";
    const chunk = chunks[i + 1] ?? "";
    // Capture the whole wrapword cell and strip tags so a title wrapped in
    // nested markup survives. Decode entities BEFORE plainText: plainText
    // emits each decoded entity as its own text node joined by spaces, which
    // would turn `Speech &amp; Language` into `Speech & Language` with
    // doubled spacing; decoding first leaves one text node.
    const titleMatch = /id=['"]wrapword['"][^>]*>([\s\S]*?)<\/td>/i.exec(chunk);
    const title = titleMatch?.[1] ? plainText(decodeHtmlEntities(titleMatch[1])) : "";
    if (!title) continue;
    const location = fieldText(chunk, "Location");
    const postedAt = parsePostedAt(fieldText(chunk, "Date Posted"), input.observedAt);
    const url = `https://${HOST}/${slug}/onlineapp/jobpostings/view.asp?AppliTrackJobId=${sourceId}`;
    const candidate = buildJob({
      ats: "applitrack",
      tenant_slug: slug,
      company: input.company,
      source_id: sourceId,
      title,
      url,
      ...(location.length > 0 ? { location_text: location } : {}),
      // No structured workplace field on the board — workplace_type is
      // inferred from title/location text, a best-effort hint only.
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

export interface ScrapeApplitrackOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
}

export interface ScrapeApplitrackOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeApplitrackTenant(
  opts: ScrapeApplitrackOptions,
): Promise<ScrapeApplitrackOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const res = await opts.client.request(
      `https://${HOST}/${opts.tenant.slug}/onlineapp/jobpostings/Output.asp?all=1`,
    );
    const httpStatus = res.status;
    const body = await res.text();
    const jobs = parseApplitrackListing({
      tenant: opts.tenant,
      company,
      body,
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
