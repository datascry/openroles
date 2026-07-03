import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import { decodeHtmlEntities, plainText } from "../normalize.ts";
import {
  assertSafeSlug,
  assertTaleoTbeCws,
  assertTaleoTbeHost,
  assertTaleoTbeInstance,
  dedupeById,
  errorToResult,
  isRecruiterTitle,
} from "./common.ts";

// Taleo Business Edition — the SMB pool, a completely separate product
// from the enterprise `taleo` careersection stack. Every customer's
// public board is server-rendered HTML on a shared pod host:
//
//   GET https://{host}/{instance}/ats/careers/v2/searchResults?org={ORG}&cws={n}
//
// (`host` = pod, e.g. `phh.tbe.taleo.net`; `instance` = pod instance path
// segment, e.g. `phh03`; `org` = the customer code, our slug; `cws`
// selects which of the org's published career sites to read.) Each job
// row is a title anchor to the requisition deep link plus a sibling
// location line:
//
//   <h4 class="oracletaleocwsv2-head-title">
//     <a href="…/careers/v2/viewRequisition?org={ORG}&cws={n}&rid={rid}"
//        class="viewJobLink">Title</a></h4>
//   <div tabindex="0">City, ST</div>
//
// The listing carries title, deep link, rid and location, so no per-job
// detail fetch is needed. It carries no posting date, so posted_at is
// never emitted (we don't guess). The org code renders uppercase in every
// anchor regardless of the request's casing, so row matching compares
// case-insensitively while requests send the lowercase slug (the server
// accepts either).
//
// Pagination is `&next&rowFrom=N` (10 rows/page, no total count
// anywhere). The first response sets a JSESSIONID cookie scoped to
// `/{instance}/ats`, and the server keys the result window on that
// session: a rowFrom request without the cookie returns a ~1-byte empty
// page. The adapter therefore echoes the JSESSIONID from page 1 on the
// later pages of the same tenant walk — nothing is persisted across
// tenants or runs. The walk ends on a page that yields no fresh rids
// (covers both the empty past-the-end page and a repeating window), a
// short page, or the MAX_PAGES backstop.
//
// robots.txt on the TBE pods returns 404 (verified on phh/tre/lde,
// 2026-07-03), which RobotsTxtCache classifies as allow-all.

const PAGE_SIZE = 10;
const DEFAULT_MAX_PAGES = 200;

export interface TaleoTbeListingRow {
  readonly rid: string;
  readonly title: string;
  readonly location?: string;
}

// One title anchor per job row: the href to the requisition deep link,
// the (possibly entity-encoded / nested-markup) title, and — immediately
// after the closing </h4> — the optional location line. Anchored on the
// `viewJobLink` class so the row's View/Apply buttons and social-share
// links (which repeat the same href) never produce extra rows.
const ROW_RE =
  /<a\s+href="([^"]*viewRequisition[^"]*)"\s+class="viewJobLink"[^>]*>([\s\S]*?)<\/a><\/h4>\s*(?:<div[^>]*>([^<]*)<\/div>)?/gi;

const ORG_PARAM_RE = /[?&]org=([A-Za-z0-9]+)/;
const RID_PARAM_RE = /[?&]rid=([0-9]+)/;

/**
 * Parse a TBE searchResults page into listing rows. Pure and
 * deterministic. Rows whose anchor lacks a rid, whose org code is not the
 * tenant's (a cross-tenant link injected into the page), or whose title
 * collapses to nothing are skipped. Duplicate rids are preserved — the
 * scrape loop's fresh-rid set is the dedupe point, because it doubles as
 * the pagination-termination signal.
 */
export function parseTaleoTbeListing(html: string, org: string): TaleoTbeListingRow[] {
  const wantOrg = org.toLowerCase();
  const rows: TaleoTbeListingRow[] = [];
  for (const m of html.matchAll(ROW_RE)) {
    const href = decodeHtmlEntities(m[1] ?? "");
    const anchorOrg = ORG_PARAM_RE.exec(href)?.[1];
    if (anchorOrg === undefined || anchorOrg.toLowerCase() !== wantOrg) continue;
    const rid = RID_PARAM_RE.exec(href)?.[1];
    if (rid === undefined) continue;
    // Decode entities BEFORE plainText: plainText emits each decoded
    // entity as its own text node joined by spaces, which would turn
    // `R&amp;D` into `R & D`; decoding first leaves a single text node
    // that plainText passes through.
    const title = plainText(decodeHtmlEntities(m[2] ?? "")).trim();
    if (title.length === 0) continue;
    const location = m[3] !== undefined ? decodeHtmlEntities(m[3]).trim() : "";
    rows.push({ rid, title, ...(location.length > 0 ? { location } : {}) });
  }
  return rows;
}

// Pull the JSESSIONID pair out of a response's Set-Cookie headers.
// Returns undefined when the response set none (the walk then ends
// naturally after page 1, because cookie-less rowFrom pages are empty).
function extractSessionCookie(headers: Headers): string | undefined {
  for (const sc of headers.getSetCookie()) {
    const m = /^\s*(JSESSIONID=[^;]+)/.exec(sc);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

export interface ScrapeTaleoTbeOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly host: string;
  readonly instance: string;
  readonly cws: string;
  readonly maxPages?: number;
}

export interface ScrapeTaleoTbeOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeTaleoTbeTenant(
  opts: ScrapeTaleoTbeOptions,
): Promise<ScrapeTaleoTbeOutcome> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  try {
    assertSafeSlug(opts.tenant.slug);
    assertTaleoTbeHost(opts.host);
    assertTaleoTbeInstance(opts.instance);
    assertTaleoTbeCws(opts.cws);
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const base = `https://${opts.host}/${opts.instance}/ats/careers/v2/searchResults?org=${opts.tenant.slug}&cws=${opts.cws}`;
    const collected: Job[] = [];
    const seenRids = new Set<string>();
    let cookie: string | undefined;
    let httpStatus = 0;
    let sawFullFinalPage = false;

    for (let page = 0; page < maxPages; page++) {
      const url = page === 0 ? base : `${base}&next&rowFrom=${page * PAGE_SIZE}`;
      const res = await opts.client.request(url, {
        ...(cookie !== undefined ? { headers: { cookie } } : {}),
      });
      httpStatus = res.status;
      if (page === 0) cookie = extractSessionCookie(res.headers);
      const rows = parseTaleoTbeListing(await res.text(), opts.tenant.slug);
      const fresh = rows.filter((r) => !seenRids.has(r.rid));
      // No fresh rids means the empty past-the-end page or a repeating
      // window — either way the listing is exhausted.
      if (fresh.length === 0) break;
      for (const row of fresh) {
        seenRids.add(row.rid);
        const url2 = `https://${opts.host}/${opts.instance}/ats/careers/v2/viewRequisition?org=${opts.tenant.slug}&cws=${opts.cws}&rid=${row.rid}`;
        const candidate = buildJob({
          ats: "taleotbe",
          tenant_slug: opts.tenant.slug,
          company,
          source_id: row.rid,
          title: row.title,
          url: url2,
          ...(row.location !== undefined ? { location_text: row.location } : {}),
          workplace_hint: `${row.title} ${row.location ?? ""}`,
          is_recruiter_post: isRecruiterTitle(row.title),
          first_seen_at: opts.observedAt,
          last_seen_at: opts.observedAt,
        });
        const validated = JobSchema.safeParse(candidate);
        if (validated.success) collected.push(validated.data);
      }
      if (rows.length < PAGE_SIZE) break;
      sawFullFinalPage = page === maxPages - 1;
    }

    const jobs = dedupeById(collected);
    return {
      jobs,
      result: {
        slug: opts.tenant.slug,
        status: "success",
        ...(httpStatus > 0 ? { http_status: httpStatus } : {}),
        // A full page on the last allowed iteration means the board may
        // hold more roles than the cap let us walk — say so rather than
        // silently truncating.
        ...(sawFullFinalPage ? { error: `capped at ${maxPages} pages` } : {}),
        jobs_count: jobs.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
