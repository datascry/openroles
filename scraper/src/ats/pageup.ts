import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import { decodeHtmlEntities, plainText } from "../normalize.ts";
import {
  assertPageupClientKey,
  assertPageupHost,
  assertPageupInstance,
  assertSafeSlug,
  dedupeById,
  errorToResult,
  isRecruiterTitle,
} from "./common.ts";

// PageUp hosted careers boards. Every customer's public board is a
// server-rendered HTML listing on a shared PageUp career host:
//
//   GET https://{host}/{instance}/{clientkey}/en/listing/?page={N}
//
// (`host` = one of careers / careersmanager / careersite.pageuppeople.com;
// `instance` = the numeric pod id, e.g. `438`; `clientkey` = the customer
// code, e.g. `caw`.) Each open role is one or more `job-link` anchors to the
// requisition deep link:
//
//   <a class="job-link" href="/438/caw/en/job/945128/senior-product-coordinator">
//     Senior Product Coordinator</a>
//   …<span class="location">Various Locations</span>…
//
// Two board templates are in the wild. The classic one renders one title
// anchor per row; the current one renders the title anchor plus a second
// `job-link` to the same href whose text is a UI label ("See Details"). Both
// are handled by keying rows on the numeric job id parsed from the href and
// preferring the anchor whose text is a real title over the label duplicate.
//
// The listing carries the title, the deep link (id + slug) and — when the
// board is configured to show it — a location, so jobs are built from the
// listing alone (no per-job detail fetch). It exposes only an application
// CLOSE date (`<span class="close-date"><time datetime=…>`), never a posting
// date, so posted_at is never emitted — we don't guess.
//
// Tenant identity is the composite (host, instance, clientkey): a clientkey
// is not globally unique (demo keys such as `caw`/`cw` recur across many
// instances), so the stable slug is `{instance}-{clientkey}` and all three
// metadata values are mandatory (the workday/taleotbe convention). None is
// slug-derivable, so a tenant missing any is dead.
//
// Pagination is `?page=N`. Neither the "More Jobs" load-more button (it is
// rendered unconditionally, even on the final page) nor the sidebar facet
// counts are reliable end-of-list signals, so the walk terminates the same
// way the taleotbe walk does: on the first page that yields no fresh job ids
// (the empty past-the-end page), a short page, or the MAX_PAGES backstop.
//
// robots.txt on the PageUp career hosts (verified on careers /
// careersmanager, 2026-07-03) disallows only admin/uat/staging boards and a
// handful of demo keys (`/*/ci/`, …); the `…/en/listing/` path of a seeded
// tenant is allowed.

// One page renders a fixed window (15 rows on the classic template, 20 on
// the current one). PAGE_SIZE is the smaller of the two; a page returning
// fewer than one row cannot precede a full next page, but the fresh-id check
// is the authoritative terminator so PAGE_SIZE only drives the short-page
// early stop.
const PAGE_SIZE = 15;

// Hard ceiling on the pagination walk. The largest boards observed run into
// the low dozens of pages; the cap only bites on pathological boards, and
// when it does the truncation is surfaced on the TenantResult.
const DEFAULT_MAX_PAGES = 200;

// UI-label anchor texts that share a job's href but are not its title. A row
// whose only anchor text is one of these is skipped (its title comes from the
// sibling anchor keyed on the same id).
const LABEL_TEXTS = new Set(["see details", "more jobs", "apply", "view", "view job"]);

// Every `job-link` anchor: the deep-link href (path only), the numeric job
// id, the url slug, and the anchor text (possibly entity-encoded / nested).
// The `class="job-link"` anchor is the only element linking to `/en/job/`, so
// this never picks up navigation or share links.
const ANCHOR_RE =
  /<a\s+class="job-link"\s+href="(\/\d+\/[a-z0-9-]+\/en\/job\/(\d+)\/([^"]*))"[^>]*>([\s\S]*?)<\/a>/gi;

export interface PageupListingRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly location?: string;
}

// Read the `<span class="location">…</span>` value for the row whose anchor
// ends at `fromIndex`. The scan is bounded to the row itself so a row with no
// location cell never borrows a neighbour's — or, for the last anchor on the
// page (`nextAnchorIndex < 0`), a stray `location`-classed span in a footer,
// sidebar facet or "suggested roles" widget after the final row. Both board
// templates wrap each role in a `<li>…</li>`, so the row's closing `</li>`
// is the upper bound; the next job anchor caps it further (a malformed page
// missing the `</li>` still can't cross into the next row). Returns "" when
// absent.
function locationAfter(html: string, fromIndex: number, nextAnchorIndex: number): string {
  // Prefer the row's own `</li>` and the next job anchor, then fall back to
  // the surrounding list structure (`</ul>`, next `<li`). When a malformed
  // final row has none of these, cap at a fixed window so the scan can never
  // run to end-of-document and borrow a footer/sidebar `location` span — a
  // location cell always sits within a few hundred bytes of its anchor.
  const LAST_ROW_WINDOW = 800;
  const bounds = [
    html.indexOf("</li>", fromIndex),
    nextAnchorIndex,
    html.indexOf("</ul>", fromIndex),
    html.indexOf("<li", fromIndex),
  ].filter((i) => i >= 0);
  const end = bounds.length > 0 ? Math.min(...bounds) : fromIndex + LAST_ROW_WINDOW;
  const slice = html.slice(fromIndex, end);
  const m = /<span class="location">([\s\S]*?)<\/span>/i.exec(slice);
  return m?.[1] ? decodeHtmlEntities(plainText(m[1])).trim() : "";
}

/**
 * Parse a PageUp listing page into rows. Pure and deterministic. Rows are
 * keyed on the numeric job id: the title is the first anchor text for that id
 * that is a real title (not a UI label), and the location is read from the
 * markup immediately after that anchor. Duplicate ids collapse to one row —
 * the scrape loop's fresh-id set is the pagination terminator, so it doubles
 * as the dedupe point, but collapsing here keeps a single page self-consistent.
 */
interface PageupAnchor {
  readonly id: string;
  readonly slug: string;
  readonly text: string;
  readonly end: number;
  readonly next: number;
}

// Collect every job-link anchor with the byte offset of its end and of the
// following anchor, so a row's location lookup can be bounded to the markup
// between this anchor and the next.
function collectAnchors(html: string): PageupAnchor[] {
  const raw: Array<Omit<PageupAnchor, "next">> = [];
  for (const m of html.matchAll(ANCHOR_RE)) {
    const id = m[2];
    const slug = m[3];
    if (id === undefined || slug === undefined) continue;
    // Decode entities BEFORE plainText: plainText emits each decoded entity as
    // its own text node joined by spaces, which would turn `R&amp;D` into
    // `R & D`; decoding first leaves a single text node it passes through.
    const text = plainText(decodeHtmlEntities(m[4] ?? "")).trim();
    raw.push({ id, slug, text, end: (m.index ?? 0) + m[0].length });
  }
  return raw.map((a, i) => ({ ...a, next: raw[i + 1]?.end ?? -1 }));
}

export function parsePageupListing(html: string): PageupListingRow[] {
  const byId = new Map<string, PageupListingRow>();
  for (const a of collectAnchors(html)) {
    // Only a real title (not a UI label like "See Details", and not the
    // first-seen label anchor of a row whose title anchor comes later) seeds a
    // row; once an id has a row, its duplicate anchors are ignored.
    const isLabel = a.text.length === 0 || LABEL_TEXTS.has(a.text.toLowerCase());
    if (isLabel || byId.has(a.id)) continue;
    const location = locationAfter(html, a.end, a.next);
    byId.set(a.id, {
      id: a.id,
      slug: a.slug,
      title: a.text,
      ...(location.length > 0 ? { location } : {}),
    });
  }
  return [...byId.values()];
}

export interface ScrapePageupOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly host: string;
  readonly instance: string;
  readonly clientKey: string;
  readonly maxPages?: number;
}

export interface ScrapePageupOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapePageupTenant(opts: ScrapePageupOptions): Promise<ScrapePageupOutcome> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  try {
    assertSafeSlug(opts.tenant.slug);
    assertPageupHost(opts.host);
    assertPageupInstance(opts.instance);
    assertPageupClientKey(opts.clientKey);
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const base = `https://${opts.host}/${opts.instance}/${opts.clientKey}/en/listing/`;
    const collected: Job[] = [];
    const seenIds = new Set<string>();
    let httpStatus = 0;
    let sawFullFinalPage = false;

    for (let page = 1; page <= maxPages; page++) {
      const url = page === 1 ? base : `${base}?page=${page}`;
      const res = await opts.client.request(url);
      httpStatus = res.status;
      const rows = parsePageupListing(await res.text());
      const fresh = rows.filter((r) => !seenIds.has(r.id));
      // No fresh ids means the empty past-the-end page or a repeating window —
      // either way the listing is exhausted.
      if (fresh.length === 0) break;
      for (const row of fresh) {
        seenIds.add(row.id);
        const url2 = `https://${opts.host}/${opts.instance}/${opts.clientKey}/en/job/${row.id}/${row.slug}`;
        const candidate = buildJob({
          ats: "pageup",
          tenant_slug: opts.tenant.slug,
          company,
          source_id: row.id,
          title: row.title,
          url: url2,
          ...(row.location !== undefined ? { location_text: row.location } : {}),
          // PageUp exposes no structured workplace field, so workplace_type is
          // inferred from the title/location text — a best-effort hint, not an
          // authoritative signal.
          workplace_hint: `${row.title} ${row.location ?? ""}`,
          is_recruiter_post: isRecruiterTitle(row.title),
          first_seen_at: opts.observedAt,
          last_seen_at: opts.observedAt,
        });
        const validated = JobSchema.safeParse(candidate);
        if (validated.success) collected.push(validated.data);
      }
      // A short page cannot precede a full next page, so stop early.
      if (rows.length < PAGE_SIZE) break;
      sawFullFinalPage = page === maxPages;
    }

    const jobs = dedupeById(collected);
    return {
      jobs,
      result: {
        slug: opts.tenant.slug,
        status: "success",
        ...(httpStatus > 0 ? { http_status: httpStatus } : {}),
        // A full page on the last allowed iteration means the board may hold
        // more roles than the cap let us walk — say so rather than silently
        // truncating.
        ...(sawFullFinalPage ? { error: `capped at ${maxPages} pages` } : {}),
        jobs_count: jobs.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
