import type { ATSId } from "@openroles/shared";

export interface AtsHarvestPattern {
  readonly ats: ATSId;
  readonly cdxQuery: string;
  readonly regex: RegExp;
  readonly denyList: ReadonlySet<string>;
  // Some ATSes need more than a slug to compose a working job-board URL.
  // Workday's API URL is `{host}/wday/cxs/{tenant}/{site}/jobs` — the host
  // and site can't be inferred from the slug. Ultipro's is
  // `recruiting.ultipro.com/{tenant}/JobBoard/{guid}/Search`. When the
  // pattern's regex captures these extra groups, this hook converts a
  // RegExpExecArray into the metadata bag stored on the tenant record.
  // Returning undefined skips metadata for that match (the slug still
  // counts).
  readonly extractMetadata?: (match: RegExpExecArray) => Record<string, string> | undefined;
}

// Path-based ATSes (slug appears as a URL path segment): deny terms that look
// like reserved path words on the public board host.
const PATH_DENY: ReadonlySet<string> = new Set([
  "embed",
  "support",
  "help",
  "docs",
  "blog",
  "status",
  "auth",
  "login",
  "admin",
  "assets",
  "static",
  "cdn",
  "api",
  "app",
  "www",
]);

// Subdomain-based ATSes (slug appears as a DNS label): deny well-known
// non-tenant subdomains. Generic words like "embed" / "support" are NOT
// excluded here because real companies do use them as tenant slugs.
const SUBDOMAIN_DENY: ReadonlySet<string> = new Set([
  "www",
  "app",
  "api",
  "assets",
  "static",
  "cdn",
  "admin",
  "login",
  "auth",
]);

const HARVEST_PATTERNS: ReadonlyArray<AtsHarvestPattern> = [
  {
    ats: "greenhouse",
    cdxQuery: "boards.greenhouse.io/*",
    // The canonical /{slug} board URL is the only path Common Crawl ever
    // captures: greenhouse's robots.txt sets `Disallow: /embed/`, so iframe-
    // embed URLs (`/embed/job_app?for={slug}`) never appear in CDX results.
    regex: /boards\.greenhouse\.io\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:[/?#]|$)/gi,
    denyList: PATH_DENY,
  },
  {
    ats: "lever",
    cdxQuery: "jobs.lever.co/*",
    regex: /jobs\.lever\.co\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:[/?#]|$)/gi,
    denyList: PATH_DENY,
  },
  {
    ats: "ashby",
    cdxQuery: "jobs.ashbyhq.com/*",
    regex: /jobs\.ashbyhq\.com\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:[/?#]|$)/gi,
    denyList: PATH_DENY,
  },
  {
    ats: "bamboohr",
    cdxQuery: "*.bamboohr.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.bamboohr\.com\//gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "workday",
    // Capture (slug, host suffix, site). Three CDX URL surfaces all carry
    // the site code in different positions; a single regex with two
    // alternatives covers them:
    //   1. API pivot:  `{host}/wday/cxs/{tenant}/{site}/...`     → group 3
    //   2. User-facing: `{host}/{Site}` or `{host}/{tenant}/{Site}` → group 4
    //   3. Bare host:  `{host}/`                                 → no site
    //
    // The `i` flag is dropped (vs other patterns) because the user-facing
    // alternative needs `[A-Z]` to mean uppercase only — workday site
    // names start with a capital letter, and we use that to distinguish
    // them from path tokens like "job" or "external" in nested URLs.
    // CDX SURT URLs are lowercase so the host portion still matches.
    cdxQuery: "*.myworkdayjobs.com/*",
    regex:
      /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(\.wd\d+(?:-[a-z0-9-]+)?\.myworkdayjobs\.com)(?:\/wday\/cxs\/[a-z0-9-]+\/([A-Za-z0-9_-]{1,64})|\/(?:[a-z0-9-]+\/)?([A-Z][A-Za-z0-9_-]{0,63})(?=\/|\?|$))?/g,
    denyList: SUBDOMAIN_DENY,
    extractMetadata: (match) => {
      const slug = match[1];
      const suffix = match[2];
      const site = match[3] ?? match[4];
      if (!slug || !suffix) return undefined;
      const host = `${slug}${suffix}`;
      return site && site.length > 0 ? { host, site } : { host };
    },
  },
  {
    ats: "icims",
    // CDX's prefix-match semantics on URL queries do not honor wildcards
    // inside a host segment (the SURT urlkey is rooted at the registrable
    // domain), so `careers-*.icims.com/*` never matches anything. The full
    // `*.icims.com/*` form does. Only ~57% of real iCIMS career sites use
    // the `careers-` subdomain prefix; the other 43% use varied prefixes
    // (`{branded}careers-{tenant}`, `{tenant1}-{tenant2}`, etc.), so the
    // tenant slug is the entire subdomain label rather than a stripped
    // suffix. The probe and scraper compose the URL as
    // `https://{slug}.icims.com/sitemap.xml`.
    cdxQuery: "*.icims.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.icims\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "recruitee",
    cdxQuery: "*.recruitee.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.recruitee\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "breezy",
    cdxQuery: "*.breezy.hr/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.breezy\.hr/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "personio",
    // Personio production career sites live under `{tenant}.jobs.personio.com`
    // (and a smaller `.de` mirror; the probe accepts either via the dedicated
    // probe URL builder).
    cdxQuery: "*.jobs.personio.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.jobs\.personio\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "workable",
    // Two URL surfaces are both common: subdomain `{tenant}.workable.com`
    // and path-based `apply.workable.com/{tenant}`. The alternation covers
    // both so the regex ignores the route the URL happened to be linked from.
    cdxQuery: "*.workable.com/*",
    regex:
      /https?:\/\/(?:apply\.workable\.com\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)|([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.workable\.com)/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "teamtailor",
    cdxQuery: "*.teamtailor.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.teamtailor\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "smartrecruiters",
    // Path-based slug under careers.smartrecruiters.com/{tenant}. The host
    // itself is constant; the company identifier is the first path segment.
    cdxQuery: "careers.smartrecruiters.com/*",
    regex: /careers\.smartrecruiters\.com\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:[/?#]|$)/gi,
    denyList: PATH_DENY,
  },
  {
    ats: "csod",
    cdxQuery: "*.csod.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.csod\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "taleo",
    // Two surface forms: bare `{tenant}.taleo.net/...` and the TBE pool
    // `{tenant}.tbe.taleo.net/...`. Both use the first label as the slug.
    cdxQuery: "*.taleo.net/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:\.tbe)?\.taleo\.net/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "ultipro",
    // Path-based: `recruiting.ultipro.com/{TENANT_CODE}/JobBoard/{guid}/...`.
    // The slug (group 1) is the first path segment — an uppercase
    // alphanumeric code (5-32 chars), lowercased on extraction so it
    // round-trips through the shared SLUG_PATTERN, then uppercased again
    // at probe/scrape URL time. The optional GUID (group 2) is the
    // per-board identifier UKG assigns to each career site; without it
    // the JobBoard URL 404s, so we capture and store it as
    // `metadata.board_id`. Bare landing pages
    // (`recruiting.ultipro.com/{TENANT}` with nothing else) leave group 2
    // empty; the slug still counts but the tenant stays at
    // transient_failure until a CDX entry surfaces the GUID.
    cdxQuery: "recruiting.ultipro.com/*",
    regex:
      /recruiting\.ultipro\.com\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:\/JobBoard\/([0-9a-f-]{32,40}))?(?:[/?#]|$)/gi,
    denyList: PATH_DENY,
    extractMetadata: (match) => {
      const guid = match[2];
      if (typeof guid !== "string" || guid.length === 0) return undefined;
      return { board_id: guid };
    },
  },
  {
    ats: "jobvite",
    cdxQuery: "jobs.jobvite.com/*",
    regex: /jobs\.jobvite\.com\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:[/?#]|$)/gi,
    denyList: PATH_DENY,
  },
  {
    ats: "zohorecruit",
    cdxQuery: "*.zohorecruit.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.zohorecruit\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "talentlyft",
    cdxQuery: "*.talentlyft.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.talentlyft\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "pinpointhq",
    cdxQuery: "*.pinpointhq.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.pinpointhq\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "applicantpro",
    cdxQuery: "*.applicantpro.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.applicantpro\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "applicantstack",
    cdxQuery: "*.applicantstack.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.applicantstack\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "homerun",
    cdxQuery: "*.homerun.co/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.homerun\.co/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "factorial",
    cdxQuery: "*.factorialhr.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.factorialhr\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "eightfold",
    cdxQuery: "*.eightfold.ai/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.eightfold\.ai/gi,
    denyList: SUBDOMAIN_DENY,
  },
  // Phase-6 custom ATSes — each is single-tenant, so group 1 captures
  // the literal canonical slug embedded in the host. CDX surfaces the
  // public board URL on every page of recent crawls, so harvest will
  // discover the single tenant on the first matching record and stop
  // (extractSlugs dedupes by slug).
  {
    ats: "amazonjobs",
    cdxQuery: "amazon.jobs/*",
    regex: /https?:\/\/(amazon)\.jobs\b/gi,
    denyList: new Set<string>(),
  },
  {
    ats: "applejobs",
    cdxQuery: "jobs.apple.com/*",
    regex: /https?:\/\/jobs\.(apple)\.com\b/gi,
    denyList: new Set<string>(),
  },
  {
    ats: "tiktokcareers",
    cdxQuery: "careers.tiktok.com/*",
    regex: /https?:\/\/careers\.(tiktok)\.com\b/gi,
    denyList: new Set<string>(),
  },
  {
    ats: "metacareers",
    cdxQuery: "metacareers.com/*",
    regex: /https?:\/\/(?:www\.)?(meta)careers\.com\b/gi,
    denyList: new Set<string>(),
  },
  {
    ats: "successfactors",
    // SuccessFactors career sites are addressed by a regional datacenter
    // host (`career{N}.successfactors.{eu|com|de|com.cn|fr|co.uk}`) plus
    // a `company={slug}` query parameter. The slug is the only
    // tenant-identifier; the datacenter host is per-tenant routing
    // metadata that we capture so the scraper knows which regional
    // cluster to hit.
    //
    // extractSlugs reads `m[1]` as the slug (convention shared with
    // every other pattern), so group 1 captures the slug from the
    // query string. The host is parsed out of the full match string
    // inside extractMetadata via a secondary regex; SuccessFactors is
    // the only ATS where the slug is not part of the host, so the
    // pattern is necessarily a little unusual.
    cdxQuery: "*.successfactors.*",
    regex:
      /https?:\/\/career[0-9]{1,3}\.successfactors\.(?:com|eu|de|com\.cn|fr|co\.uk)\/career\?[^"\s]*company=([a-z0-9-]+)/gi,
    denyList: SUBDOMAIN_DENY,
    extractMetadata: (match) => {
      const hostMatch = /career[0-9]{1,3}\.successfactors\.(?:com|eu|de|com\.cn|fr|co\.uk)/i.exec(
        match[0],
      );
      return hostMatch ? { host: hostMatch[0] } : undefined;
    },
  },
  // The jsonld harvester is vendor-agnostic: tenants are hand-seeded
  // with a `sitemap_url` rather than discovered from a canonical CDX
  // host pattern. We register a no-op pattern that captures the
  // vendor-neutral hostnames of any sitemap URL the corpus references —
  // this keeps the `HARVEST_ATS_IDS == ATS_IDS` invariant intact and
  // documents that this ATS is intentionally not CDX-driven. The slug
  // group matches the literal token `jsonld` against itself in the
  // deny list, so the regex never produces a fresh tenant from CDX
  // (operator-curated seeds are the only path).
  {
    ats: "jsonld",
    cdxQuery: "schema.org/JobPosting/*",
    regex: /\b(jsonld)\b/gi,
    denyList: new Set<string>(["jsonld"]),
  },
  // BrassRing tenants share the host `sjobs.brassring.com` and are
  // selected by (partnerid, siteid) query parameters — the slug is
  // operator-assigned (brand-friendly) rather than derivable from the
  // URL. CDX can enumerate the partnerid+siteid pairs that exist
  // (123 unique pairs in CC-MAIN-2026-17), but the slug naming
  // requires identifying each brand by hand. Initial seeds are
  // operator-curated; the pattern is registered as a placeholder
  // to keep HARVEST_ATS_IDS == ATS_IDS without spuriously matching.
  {
    ats: "brassring",
    cdxQuery: "sjobs.brassring.com/TGnewUI/Search/Home/Home*",
    regex: /\b(brassring)\b/gi,
    denyList: new Set<string>(["brassring"]),
  },
  // Like jsonld, the Google-for-Jobs RSS feed harvester is hand-seeded
  // (tenant identity = slug + feed_url, not a canonical CDX host
  // pattern). Registered as a no-op pattern so HARVEST_ATS_IDS ==
  // ATS_IDS holds; the regex matches the literal token `gjobsfeed`
  // against the deny list so CDX never mints a fresh tenant.
  {
    ats: "gjobsfeed",
    cdxQuery: "base.google.com/ns/1.0",
    regex: /\b(gjobsfeed)\b/gi,
    denyList: new Set<string>(["gjobsfeed"]),
  },
  // Oracle Fusion HCM Candidate Experience tenants are addressed by the
  // composite (host, site): a per-tenant Fusion pod host
  // (`ejhp.fa.us6.oraclecloud.com`) plus a CE site code (`CX_2`). CDX can
  // enumerate which pods exist, but the pod prefix is an opaque datacenter
  // code — not a brand name — so mapping a pod to a company slug needs
  // operator knowledge (the same situation as brassring's partnerid/siteid
  // pairs). Initial seeds are therefore operator-curated in
  // data/tenants/oraclecloud.json; this registered placeholder never mints a
  // fresh tenant from CDX (the regex matches the literal token against its
  // own deny list), keeping the HARVEST_ATS_IDS == ATS_IDS invariant intact.
  {
    ats: "oraclecloud",
    cdxQuery: "*.oraclecloud.com/hcmUI/CandidateExperience/*",
    regex: /\b(oraclecloud)\b/gi,
    denyList: new Set<string>(["oraclecloud"]),
  },
  {
    ats: "jazzhr",
    // JazzHR hosted boards live at `{slug}.applytojob.com`; the tenant
    // slug is the subdomain label (same shape as bamboohr/breezy).
    cdxQuery: "*.applytojob.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.applytojob\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "phenom",
    cdxQuery: "*.phenompeople.com/*",
    regex: /\b(phenom)\b/gi,
    denyList: new Set<string>(["phenom"]),
  },
  // Apploi tenants share the host ats-integrations.apploi.com and are
  // selected by a verbatim `brand` name string in the query — the slug is
  // operator-assigned (brand-friendly kebab case) rather than derivable
  // from any URL. CDX could enumerate job-card URLs, but mapping an id
  // back to its brand string requires reading each posting by hand, so
  // seeds are operator-curated in data/tenants/apploi.json. The pattern is
  // registered as a placeholder to keep HARVEST_ATS_IDS == ATS_IDS without
  // spuriously matching (the regex matches the literal token against its
  // own deny list, so CDX never mints a fresh tenant).
  {
    ats: "apploi",
    cdxQuery: "jobs.apploi.com/view/*",
    regex: /\b(apploi)\b/gi,
    denyList: new Set<string>(["apploi"]),
  },
  {
    ats: "isolvedhire",
    // isolved Hire hosted boards live at `{slug}.isolvedhire.com`; the tenant
    // slug is the subdomain label (same shape as bamboohr/breezy). `feeds` is
    // the platform-wide sitemap host (feeds.isolvedhire.com/site_map_index.xml),
    // not a tenant, so it joins the standard subdomain deny terms.
    cdxQuery: "*.isolvedhire.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.isolvedhire\.com/gi,
    denyList: new Set<string>([...SUBDOMAIN_DENY, "feeds"]),
  },
  // Taleo Business Edition boards are addressed by (host, instance, cws)
  // plus the org code: `{pod}.tbe.taleo.net/{instance}/ats/careers/
  // …?org={ORG}&cws={n}`. Everything is derivable from a captured careers
  // URL, so — like successfactors, the other query-param-slug ATS — the
  // slug (group 1) is the `org=` value and the host/instance/cws are
  // re-parsed out of match[0] in extractMetadata. The `.tbe.` label keeps
  // this pattern disjoint from the enterprise `taleo` pattern's bare-host
  // capture. URLs without a `cws=` (e.g. requisition deep links that only
  // carry org+rid) still mint the slug with host+instance; the tenant
  // stays at transient_failure until a cws-bearing URL (or an operator)
  // completes the composite.
  {
    ats: "taleotbe",
    cdxQuery: "*.tbe.taleo.net/*",
    // The trailing `[^"\s]*` keeps the rest of the query string inside
    // match[0] so extractMetadata can recover a `cws=` that follows the
    // org parameter.
    regex:
      /https?:\/\/[a-z0-9-]{1,32}\.tbe\.taleo\.net\/[a-z0-9]{1,32}\/ats\/careers\/[^"\s]*?[?&](?:amp;)?org=([a-z0-9]+)[^"\s]*/gi,
    denyList: SUBDOMAIN_DENY,
    extractMetadata: (match) => {
      const hostMatch = /([a-z0-9-]{1,32}\.tbe\.taleo\.net)\/([a-z0-9]{1,32})\//i.exec(match[0]);
      if (!hostMatch?.[1] || !hostMatch[2]) return undefined;
      const cws = /[?&](?:amp;)?cws=([0-9]{1,6})/i.exec(match[0])?.[1];
      return {
        host: hostMatch[1].toLowerCase(),
        instance: hostMatch[2].toLowerCase(),
        ...(cws !== undefined ? { cws } : {}),
      };
    },
  },
  {
    ats: "hrmdirect",
    // HRMDirect hosted boards live at `{slug}.hrmdirect.com`; the tenant
    // slug is the subdomain label (same shape as bamboohr/breezy).
    cdxQuery: "*.hrmdirect.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.hrmdirect\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  // SchoolSpring is single-tenant (one national K-12 board), so group 1
  // captures the literal canonical slug from the host — the same shape
  // as the phase-6 per-company customs above. CDX surfaces the public
  // board URL on every recent crawl, so harvest discovers the single
  // tenant on the first matching record and stops.
  {
    ats: "schoolspring",
    cdxQuery: "www.schoolspring.com/*",
    regex: /https?:\/\/(?:www\.)?(schoolspring)\.com\b/gi,
    denyList: new Set<string>(),
  },
  {
    ats: "applitrack",
    // Frontline AppliTrack district boards share the host
    // `www.applitrack.com`; the district slug is the first path segment
    // (`www.applitrack.com/{district}/onlineapp/...`), the same path-based
    // shape as smartrecruiters/jobvite. Beyond the generic path-word deny
    // list, the host also serves shared assets under `olacommon` and (on
    // some captures) bare `onlineapp` links, so both are excluded to keep
    // CDX asset/deep-link captures from minting phantom tenants.
    cdxQuery: "www.applitrack.com/*",
    regex: /www\.applitrack\.com\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:[/?#]|$)/gi,
    denyList: new Set<string>([...PATH_DENY, "olacommon", "onlineapp"]),
  },
  {
    ats: "hiringthing",
    // HiringThing hosted boards live at `{slug}.hiringthing.com`; the
    // tenant slug is the subdomain label (same shape as bamboohr/breezy).
    // The platform also links a global S3 sitemap of hosted boards from
    // each board's robots.txt — a complementary discovery surface to CDX.
    cdxQuery: "*.hiringthing.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.hiringthing\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "hirebridge",
    // Hirebridge boards share the single host `recruit.hirebridge.com`;
    // the tenant identity is the numeric `cid` query parameter carried on
    // every listing/detail URL (`/v3/jobs/list.aspx?cid=5535`,
    // `/v3/Jobs/JobDetails.aspx?cid=5535&jid=…`), so — unlike the
    // subdomain-shaped ATSes — the capture group reads the query string,
    // not a DNS label. The `(?:amp;)?` arm also matches URLs lifted from
    // entity-encoded HTML. A numeric-only capture can never collide with
    // reserved words, so no deny list applies.
    cdxQuery: "recruit.hirebridge.com/*",
    regex: /https?:\/\/recruit\.hirebridge\.com\/[^"'\s<>]*?[?&](?:amp;)?cid=(\d{1,9})(?!\d)/gi,
    denyList: new Set<string>(),
  },
  {
    ats: "workstream",
    // Workstream boards share the host www.workstream.us; the tenant is
    // addressed by the composite `/j/{companyId}/{slug}` path where the
    // 8-hex company id and the brand slug appear together in every board
    // and job URL. extractSlugs reads m[1] as the slug (shared convention),
    // so group 1 captures the slug; the company id is recovered from the
    // full match string inside extractMetadata via a secondary regex — the
    // same non-positional metadata recovery successfactors uses for its
    // regional host. A match whose id segment is somehow malformed yields
    // no metadata; the slug still counts, and the tenant stays dead at
    // dispatch until a later pass surfaces the id.
    cdxQuery: "www.workstream.us/j/*",
    regex: /workstream\.us\/j\/[0-9a-f]{8}\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:[/?#]|$)/gi,
    denyList: PATH_DENY,
    extractMetadata: (match) => {
      const idMatch = /\/j\/([0-9a-f]{8})\//i.exec(match[0]);
      const companyId = idMatch?.[1];
      if (typeof companyId !== "string" || companyId.length === 0) return undefined;
      return { company_id: companyId.toLowerCase() };
    },
  },
  {
    ats: "careerplug",
    // CareerPlug hosted boards live at `{slug}.careerplug.com`; the tenant
    // slug is the subdomain label (same shape as bamboohr/breezy).
    cdxQuery: "*.careerplug.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.careerplug\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "jibeapply",
    // Jibe hosted boards live at `{slug}.jibeapply.com`; the tenant slug is
    // the subdomain label (same shape as bamboohr/breezy). Vanity-CNAME
    // tenants can't surface here and are operator-seeded with metadata.host.
    cdxQuery: "*.jibeapply.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.jibeapply\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "hireology",
    // Hireology career sites are path-addressed on the shared SPA host
    // (careers.hireology.com/{slug}); the tenant slug is the first path
    // segment (same shape as smartrecruiters/jobvite).
    cdxQuery: "careers.hireology.com/*",
    regex: /careers\.hireology\.com\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:[/?#]|$)/gi,
    denyList: PATH_DENY,
  },
  {
    ats: "applicantpool",
    // ApplicantPool hosted boards live at `{slug}.applicantpool.com`; the
    // tenant slug is the subdomain label (same shape as bamboohr/breezy).
    // `feeds` is the platform-wide sitemap host
    // (feeds.applicantpool.com/site_map_index.xml), not a tenant, so it
    // joins the standard subdomain deny terms.
    cdxQuery: "*.applicantpool.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.applicantpool\.com/gi,
    denyList: new Set<string>([...SUBDOMAIN_DENY, "feeds"]),
  },
  {
    ats: "pageup",
    // PageUp hosted boards are addressed by (host, instance, clientkey):
    // `{host}/{instance}/{clientkey}/en/listing/…`. The clientkey is NOT
    // globally unique (demo keys such as `caw`/`cw` recur across many pod
    // instances), and extractSlugs mints the slug from a single captured
    // group, so the harvested slug is the clientkey (group 1) with the pod
    // host + numeric instance recovered into metadata from match[0] — the
    // same non-positional recovery successfactors/workstream use. Because two
    // distinct instances can share a clientkey, a CDX-minted tenant is a
    // best-effort seed: it dispatches from its metadata, and where a clientkey
    // genuinely collides an operator seeds the canonical `{instance}-{clientkey}`
    // slug to separate them. The demo/UAT clientkeys PageUp's robots.txt
    // disallows (`ci`, `uat`, `staging`, …) are denied so harvest never mints
    // a phantom tenant on a board we would not scrape.
    cdxQuery: "*.pageuppeople.com/*",
    regex:
      /https?:\/\/(?:careers|careersmanager|careersite)\.pageuppeople\.com\/\d{1,9}\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/(?:[a-z]{2}\/)?(?:listing|job)\b/gi,
    denyList: new Set<string>([
      "ci",
      "cwuat",
      "ciuat",
      "uat",
      "uatinternal",
      "testint",
      "staging",
      "awake",
      "admin",
    ]),
    extractMetadata: (match) => {
      const m =
        /(careers|careersmanager|careersite)\.pageuppeople\.com\/(\d{1,9})\/([a-z0-9-]+)\//i.exec(
          match[0],
        );
      const host = m?.[1];
      const instance = m?.[2];
      const clientKey = m?.[3];
      if (host === undefined || instance === undefined || clientKey === undefined) {
        return undefined;
      }
      return {
        host: `${host.toLowerCase()}.pageuppeople.com`,
        instance,
        clientkey: clientKey.toLowerCase(),
      };
    },
  },
  {
    ats: "manatal",
    // Manatal hosted boards share the host `www.careers-page.com`; the tenant
    // slug is the FIRST path segment (`/{slug}` for the board, `/{slug}/job/
    // {code}` for a role), the same path-based shape as smartrecruiters/
    // jobvite. The capture is bounded to the leading path segment, so a job
    // deep link mints the slug (`/{slug}`) rather than the reserved `job`
    // token — but `job` is added to the deny list as belt-and-braces so a
    // pathological `/job/...` capture can never become a phantom tenant.
    cdxQuery: "www.careers-page.com/*",
    // The board root often appears as a bare `.../{slug}` with no trailing
    // path, so the segment terminator is a non-consuming lookahead over any
    // delimiter (`/ ? #`, whitespace, quote/angle-bracket in HTML, or EOL)
    // rather than `(?:[/?#]|$)` — the latter would drop a slug followed by a
    // space or newline, exactly the shape CDX and raw HTML emit.
    regex: /www\.careers-page\.com\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?=[/?#\s"'<>]|$)/gi,
    denyList: new Set<string>([...PATH_DENY, "job"]),
  },
  {
    ats: "rippling",
    // Rippling boards are path-addressed on the shared host
    // (ats.rippling.com/{slug}/jobs); the tenant slug is the first path
    // segment (same shape as hireology/smartrecruiters). `internal` is the
    // one path Rippling's robots.txt disallows, so it joins the deny terms.
    cdxQuery: "ats.rippling.com/*",
    regex: /ats\.rippling\.com\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:[/?#]|$)/gi,
    denyList: new Set<string>([...PATH_DENY, "internal"]),
  },
];

const PATTERNS_BY_ATS: ReadonlyMap<ATSId, AtsHarvestPattern> = new Map(
  HARVEST_PATTERNS.map((p) => [p.ats, p]),
);

export function harvestPatternFor(ats: ATSId): AtsHarvestPattern {
  const p = PATTERNS_BY_ATS.get(ats);
  if (!p) throw new Error(`no harvest pattern for ats ${ats}`);
  return p;
}

export const HARVEST_ATS_IDS: ReadonlyArray<ATSId> = HARVEST_PATTERNS.map((p) => p.ats);

export const SLUG_PATTERN: RegExp = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
