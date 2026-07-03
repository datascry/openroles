import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { buildJob } from "../build-job.ts";
import { type HttpClient, HttpError } from "../http.ts";
import { decodeHtmlEntities, plainText } from "../normalize.ts";
import { dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

// Hirebridge hosted job boards. Every customer board lives on the single
// shared host `recruit.hirebridge.com`, selected by a numeric `cid` query
// parameter — the tenant slug IS that cid string. The listing page
// (`/v3/jobs/list.aspx?cid={cid}`) server-renders every open role on one
// page (no pagination), so a single GET per tenant covers the whole board.
//
// The listing groups roles under location headings, in one of two skins:
// most boards emit `<span class="groupbyname">{location}</span>` before
// each group's `<ul class="jobs">`, a minority emit a bare
// `<div class="row"><h2>{location}</h2></div>` section header instead.
// Each role is an `<li>` whose `<a href="/v3/Jobs/JobDetails.aspx?cid=
// {cid}&jid={jid}">` anchor carries the title, optionally followed by a
// `<span class="department">` cell. The board exposes no posting dates
// anywhere, so posted_at is omitted; the description would need an N+1
// detail fetch per role, so it is omitted too.
//
// The canonical public URL for a role is the CareerCenter details page
// (`/v3/CareerCenter/v2/details.aspx?cid={cid}&jid={jid}`) — it is the
// page that declares itself via `og:url`; the JobDetails.aspx URL the
// listing links resolves to a slimmer variant of the same content.

const HOST = "recruit.hirebridge.com";

// Tenant identity is a numeric cid that flows straight into a query
// string; anything non-numeric is an injection vector, not a tenant.
const CID_RE = /^\d{1,9}$/;

function assertHirebridgeCid(cid: string): void {
  if (!CID_RE.test(cid)) {
    throw new HttpError("permanent", `hirebridge cid rejected: ${JSON.stringify(cid)}`);
  }
}

// One pass over the document in source order, matching either a location
// group heading or a job anchor. Tracking the most recent heading gives
// each anchor the location it visually sits under; an anchor before any
// heading simply omits the location (graceful degradation — never guess).
//
// Heading arms are deliberately narrow: the `groupbyname` span, or a bare
// `<div class="row"><h2>` (the h2-skin group header). A *styled* `<h2>` is
// page copy ("Who We Are…"), not a location, and must not match.
//
// The anchor arm requires a literal `<a … href="/v3/Jobs/JobDetails.aspx…"`
// so the `onclick="window.location='/v3/Jobs/JobDetails.aspx…'"` duplicate
// each `<li>` carries never produces a second row.
const TOKEN_RE =
  /class="groupbyname"[^>]*>([\s\S]*?)<\/span>|<div class="row"><h2>([\s\S]*?)<\/h2>|<a\s[^>]*href="\/v3\/Jobs\/JobDetails\.aspx\?cid=(\d+)&(?:amp;)?jid=(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

export interface ParseHirebridgeInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly html: string;
  readonly observedAt: string;
}

// Turn one anchor match into a validated Job, or undefined when the anchor
// is unusable (empty title) or belongs to another tenant's board (footer
// resume links, corporate cross-links).
function anchorToJob(
  m: RegExpExecArray | RegExpMatchArray,
  input: ParseHirebridgeInput,
  location: string,
): Job | undefined {
  const cid = input.tenant.slug;
  if (m[3] !== cid) return undefined;
  const jid = m[4] ?? "";
  const title = m[5] ? plainText(decodeHtmlEntities(m[5])) : "";
  if (jid.length === 0 || title.length === 0) return undefined;
  // The department span sits inside the same <li> as the anchor; scan
  // only up to the closing </li> so a later group's cell can't leak in.
  const rest = input.html.slice((m.index ?? 0) + m[0].length);
  const liEnd = rest.indexOf("</li>");
  const scope = liEnd === -1 ? "" : rest.slice(0, liEnd);
  const deptMatch = /class="department"[^>]*>([\s\S]*?)<\/span>/i.exec(scope);
  let department = deptMatch?.[1] ? plainText(decodeHtmlEntities(deptMatch[1])) : "";
  // Some tenants configure the board to group by property and reuse the
  // department span for the city, so its text merely echoes the group
  // heading. An echo carries no department signal — omit it rather than
  // store a duplicate of location_text.
  if (department.toLowerCase() === location.toLowerCase()) department = "";
  const candidate = buildJob({
    ats: "hirebridge",
    tenant_slug: cid,
    company: input.company,
    source_id: jid,
    title,
    url: `https://${HOST}/v3/CareerCenter/v2/details.aspx?cid=${cid}&jid=${jid}`,
    ...(location.length > 0 ? { location_text: location } : {}),
    // The board exposes no structured workplace field, so workplace_type
    // is inferred from the title/location text — a best-effort hint, not
    // an authoritative signal.
    workplace_hint: `${title} ${location}`,
    ...(department.length > 0 ? { department } : {}),
    is_recruiter_post: isRecruiterTitle(title),
    first_seen_at: input.observedAt,
    last_seen_at: input.observedAt,
  });
  const validated = JobSchema.safeParse(candidate);
  return validated.success ? validated.data : undefined;
}

// Parse the listing into validated Jobs. Pure; deterministic; safe to
// fixture-replay and property-test. An anchor missing a usable title is
// skipped rather than failing the tenant.
export function parseHirebridgeListing(input: ParseHirebridgeInput): Job[] {
  const jobs: Job[] = [];
  let location = "";
  for (const m of input.html.matchAll(TOKEN_RE)) {
    const heading = m[1] ?? m[2];
    if (heading !== undefined) {
      // Decode entities BEFORE plainText: plainText emits each decoded
      // entity as its own text node joined by spaces, which would turn
      // `R&amp;D` into `R & D`; decoding first leaves one text node.
      location = plainText(decodeHtmlEntities(heading));
      continue;
    }
    const job = anchorToJob(m, input, location);
    if (job !== undefined) jobs.push(job);
  }
  return dedupeById(jobs);
}

export interface ScrapeHirebridgeOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
}

export interface ScrapeHirebridgeOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

// An unknown cid does not 404: the listing answers with a same-host 302 to
// the shared vendor error page `/v3/Application/AppErrMsg.aspx?cid={cid}
// &errorType=badurl` (which then serves HTTP 200). The redirect target is
// therefore the dead signal, so the listing is fetched with
// redirect:manual and the Location classified directly — a live board
// answers the listing with a direct 200.
const DEAD_REDIRECT_RE = /\/AppErrMsg\.aspx/i;

export async function scrapeHirebridgeTenant(
  opts: ScrapeHirebridgeOptions,
): Promise<ScrapeHirebridgeOutcome> {
  const slug = opts.tenant.slug;
  try {
    assertHirebridgeCid(slug);
    const company = opts.tenant.display_name ?? slug;
    const res = await opts.client.request(`https://${HOST}/v3/jobs/list.aspx?cid=${slug}`, {
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      const target = res.headers.get("location") ?? "";
      if (DEAD_REDIRECT_RE.test(target)) {
        return {
          jobs: [],
          result: {
            slug,
            status: "dead",
            http_status: res.status,
            error: "hirebridge cid not recognized (listing redirected to the vendor error page)",
            jobs_count: 0,
          },
        };
      }
      // A redirect we have not observed is unexplained — keep the tenant
      // alive (transient) rather than dropping it on an unknown shape.
      return {
        jobs: [],
        result: {
          slug,
          status: "transient_failure",
          http_status: res.status,
          error: `unexpected redirect from the hirebridge listing (HTTP ${res.status})`,
          jobs_count: 0,
        },
      };
    }
    const html = await res.text();
    const jobs = parseHirebridgeListing({
      tenant: opts.tenant,
      company,
      html,
      observedAt: opts.observedAt,
    });
    return {
      jobs,
      result: { slug, status: "success", http_status: res.status, jobs_count: jobs.length },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(slug, err) };
  }
}
