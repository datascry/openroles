import type { ATSId, Tenant, TenantStatus } from "@openroles/shared";
import pLimit from "p-limit";
import { assertWorkdayHost, assertWorkdaySite } from "../ats/common.ts";
import { type HttpClient, HttpError } from "../http.ts";

export type ProbeUrlBuilder = (slug: string) => string;

// Probe URL builders that use only the slug — covers most ATSes.
const PROBE_URL: Partial<Record<ATSId, ProbeUrlBuilder>> = {
  greenhouse: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=false`,
  lever: (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json&limit=1`,
  ashby: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
  bamboohr: (slug) => `https://${slug}.bamboohr.com/careers/list`,
  // iCIMS slug = full subdomain label (most use a `careers-` prefix but many
  // use other branded prefixes; see harvest/patterns.ts).
  icims: (slug) => `https://${slug}.icims.com/sitemap.xml`,
  recruitee: (slug) => `https://${slug}.recruitee.com/api/offers/`,
  breezy: (slug) => `https://${slug}.breezy.hr/json`,
  personio: (slug) => `https://${slug}.jobs.personio.com/xml`,
  // Workable's v3 endpoint (`/api/v3/accounts/{slug}/jobs`) returns 404 for
  // every tenant, including known-live ones. The v1 widget API at
  // `/api/v1/widget/accounts/{slug}` is the actual public read-only path
  // and returns `{ name, description, jobs: [...] }`.
  workable: (slug) => `https://apply.workable.com/api/v1/widget/accounts/${slug}`,
  // /jobs.json returns 406 (content-type negotiation, no auth) even with
  // an explicit Accept header; /jobs.rss is the public read-only feed that
  // works without auth.
  teamtailor: (slug) => `https://${slug}.teamtailor.com/jobs.rss`,
  smartrecruiters: (slug) =>
    `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=1`,
  csod: (slug) => `https://${slug}.csod.com/`,
  // Taleo career sites live under either `{tenant}.taleo.net` or the TBE
  // pool `{tenant}.tbe.taleo.net`; the careersection root returns 200 on both.
  taleo: (slug) => `https://${slug}.taleo.net/careersection/`,
  jobvite: (slug) => `https://jobs.jobvite.com/${slug}`,
  zohorecruit: (slug) => `https://${slug}.zohorecruit.com/jobs/Careers`,
  talentlyft: (slug) => `https://${slug}.talentlyft.com/`,
  pinpointhq: (slug) => `https://${slug}.pinpointhq.com/`,
  applicantpro: (slug) => `https://${slug}.applicantpro.com/jobs/`,
  applicantstack: (slug) => `https://${slug}.applicantstack.com/`,
  // The tenant landing page (`{slug}.homerun.co`) returns 200 on the empty
  // careers stub too. The Atom feed at `feed.homerun.co/{slug}` is the
  // signal we actually care about — a tenant without a published feed
  // returns 404 here.
  homerun: (slug) => `https://feed.homerun.co/${slug}`,
  // Factorial's tenant landing page returns 200 even for tenants with no
  // published careers page. The sitemap is the actual public job feed —
  // tenants without one return 404 here.
  factorial: (slug) => `https://${slug}.factorialhr.com/sitemap.xml`,
  // Eightfold's `/careers` page returns the same HTML shell for every slug
  // (the tenant-specific data loads via API behind PCSX auth). The careers
  // sitemap is the actual public signal — tenants with no published jobs
  // return 404 here.
  eightfold: (slug) => `https://${slug}.eightfold.ai/careers/sitemap.xml`,
  // workday + ultipro need composite metadata (host/site, board_id) — see
  // probeUrlForWithMetadata below.
};

// Probe URL builders that need both slug and metadata (workday, ultipro).
// These return undefined when the metadata bag is missing the required keys.
type ProbeUrlMetaBuilder = (slug: string, metadata: Record<string, string>) => string | undefined;

const PROBE_URL_META: Partial<Record<ATSId, ProbeUrlMetaBuilder>> = {
  workday: (slug, metadata) => {
    const host = metadata["host"];
    const site = metadata["site"];
    if (typeof host !== "string" || host.length === 0) return undefined;
    if (typeof site !== "string" || site.length === 0) return undefined;
    // Defensive — these strings flow into URLs, validate the shape we
    // observed in CDX before sending the network request.
    try {
      assertWorkdayHost(host);
      assertWorkdaySite(site);
    } catch {
      return undefined;
    }
    // The `/wday/cxs/{tenant}/{site}/jobs` endpoint is workday's documented
    // public read-only feed. POST with an empty `{}` body returns the page
    // 1 / 20-row default; for a probe we just need a 2xx response.
    return `https://${host}/wday/cxs/${slug}/${site}/jobs`;
  },
  ultipro: (slug, metadata) => {
    const boardId = metadata["board_id"];
    if (typeof boardId !== "string" || boardId.length === 0) return undefined;
    if (!/^[0-9a-f-]{32,40}$/i.test(boardId)) return undefined;
    // Tenant codes are uppercased on the public URL — we lowercase on
    // harvest to round-trip through SLUG_PATTERN, then uppercase here.
    return `https://recruiting.ultipro.com/${slug.toUpperCase()}/JobBoard/${boardId}/JobBoardView/LoadSearchResults`;
  },
};

export function probeUrlFor(ats: ATSId, slug: string): string {
  const build = PROBE_URL[ats];
  if (!build) throw new Error(`probe URL not defined for ats ${ats}`);
  return build(slug);
}

// Composite-metadata variant: returns undefined for ATSes that don't need
// metadata, the URL string when the metadata is sufficient to compose a
// probe URL, and undefined when the metadata bag is missing keys (caller
// should treat that as transient_failure).
export function probeUrlForWithMetadata(
  ats: ATSId,
  slug: string,
  metadata: Record<string, string> | undefined,
): string | undefined {
  const build = PROBE_URL_META[ats];
  if (!build) return undefined;
  return build(slug, metadata ?? {});
}

interface ProbeRequestShape {
  readonly method: "GET" | "POST";
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

// Some composite-metadata ATSes need a non-GET probe (ultipro's
// `LoadSearchResults` endpoint is POST + JSON body; GET returns 415). The
// shape is tied to the probe URL builder above, so colocate it.
const PROBE_REQUEST_SHAPE: Partial<Record<ATSId, ProbeRequestShape>> = {
  ultipro: {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json", accept: "application/json" },
  },
};

export interface ProbeOptions {
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly concurrency?: number;
  // Optional metadata hint per slug — used by workday / ultipro whose probe
  // URL needs more than the slug to compose. Slugs without metadata in the
  // map fall back to transient_failure for those ATSes.
  readonly metadataBySlug?: ReadonlyMap<string, Record<string, string>>;
}

const DEFAULT_PROBE_CONCURRENCY = 6;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

// Hard ceiling on how long a single probe may take before we declare it
// `transient_failure` and let probeMany advance. HttpClient already has
// a 30s AbortSignal.timeout, but Bun's fetch has documented edge cases
// where TLS-handshake or DNS-resolution hangs evade the abort and leave
// the promise unsettled — observed in production: a workable reprobe of
// 14k tenants stalled for 80+ minutes with 0% CPU and zero open sockets.
// One unsettled promise blocks a pLimit slot, eventually all 6 slots
// fill, and the whole batch deadlocks. This wrapper guarantees forward
// progress regardless of fetch internals.
const HARD_PROBE_TIMEOUT_MS = 45_000;

async function withHardTimeout<T>(work: Promise<T>, fallback: T, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function probeOne(
  ats: ATSId,
  slug: string,
  client: HttpClient,
  observedAt: string,
  metadata?: Record<string, string>,
): Promise<Tenant> {
  // Hard-timeout the entire probe attempt. See HARD_PROBE_TIMEOUT_MS.
  const fallback: Tenant = { ats, slug, status: "transient_failure", last_probed_at: observedAt };
  return await withHardTimeout(
    probeOneInner(ats, slug, client, observedAt, metadata),
    metadata ? { ...fallback, metadata } : fallback,
    HARD_PROBE_TIMEOUT_MS,
  );
}

async function probeOneInner(
  ats: ATSId,
  slug: string,
  client: HttpClient,
  observedAt: string,
  metadata?: Record<string, string>,
): Promise<Tenant> {
  if (!SLUG_RE.test(slug)) {
    return { ats, slug, status: "dead", last_probed_at: observedAt };
  }
  // For ATSes whose probe URL needs composite metadata: if the harvester
  // captured it, build the URL and probe. If not, stay at transient_failure
  // — a future harvest pass that surfaces the missing metadata pivots us
  // out of that state without losing the slug.
  if (PROBE_URL_META[ats]) {
    const url = probeUrlForWithMetadata(ats, slug, metadata);
    if (!url) {
      const result: Tenant = {
        ats,
        slug,
        status: "transient_failure",
        last_probed_at: observedAt,
      };
      return metadata ? { ...result, metadata } : result;
    }
    const shape: ProbeRequestShape = PROBE_REQUEST_SHAPE[ats] ?? { method: "GET" };
    try {
      await client.request(url, {
        method: shape.method,
        skipRobots: true,
        ...(shape.body !== undefined ? { body: shape.body } : {}),
        ...(shape.headers !== undefined ? { headers: shape.headers } : {}),
      });
      return { ats, slug, status: "live", last_probed_at: observedAt, metadata: metadata ?? {} };
    } catch (err) {
      const status: TenantStatus =
        err instanceof HttpError && err.kind === "transient" ? "transient_failure" : "dead";
      const result: Tenant = { ats, slug, status, last_probed_at: observedAt };
      return metadata ? { ...result, metadata } : result;
    }
  }
  try {
    // Some ATS API hosts publish robots.txt with `Disallow: /` even though
    // their public read-only API is documented and intended for programmatic
    // use (smartrecruiters whitelists LinkedInBot, others are silent).
    // Treat the probe URL as an API call rather than a crawl.
    await client.request(probeUrlFor(ats, slug), { method: "GET", skipRobots: true });
    return { ats, slug, status: "live", last_probed_at: observedAt };
  } catch (err) {
    if (err instanceof HttpError) {
      // Homerun's AWS ELB now blanket-403s every direct request to
      // `*.homerun.co` and `feed.homerun.co/*` regardless of headers
      // (anti-bot at the load-balancer level, fingerprints the TLS or
      // user-agent). Marking 1,780 tenants as `dead` based on that
      // would lose them all. Until a working homerun probe surfaces,
      // map their 403s to `transient_failure` so they survive in the
      // corpus pending an alternate signal.
      if (ats === "homerun" && err.status === 403) {
        return { ats, slug, status: "transient_failure", last_probed_at: observedAt };
      }
      const status: TenantStatus = err.kind === "transient" ? "transient_failure" : "dead";
      return { ats, slug, status, last_probed_at: observedAt };
    }
    return { ats, slug, status: "transient_failure", last_probed_at: observedAt };
  }
}

export function probeMany(
  ats: ATSId,
  slugs: ReadonlyArray<string>,
  opts: ProbeOptions,
): Promise<Tenant[]> {
  const limit = pLimit(opts.concurrency ?? DEFAULT_PROBE_CONCURRENCY);
  return Promise.all(
    slugs.map((slug) =>
      limit(() =>
        probeOne(ats, slug, opts.client, opts.observedAt, opts.metadataBySlug?.get(slug)),
      ),
    ),
  );
}
