import { z } from "zod";

// Canonical sort order for the ATS dimension. Phase-1 set (greenhouse →
// icims) is followed by phase-9 additions; new entries append to preserve
// stable hash ordering in any persisted records that use ATS_RANK.
export const ATS_IDS = Object.freeze([
  "greenhouse",
  "lever",
  "ashby",
  "bamboohr",
  "workday",
  "icims",
  "recruitee",
  "breezy",
  "personio",
  "workable",
  "teamtailor",
  "smartrecruiters",
  "csod",
  "taleo",
  "ultipro",
  "jobvite",
  "zohorecruit",
  "talentlyft",
  "pinpointhq",
  "applicantpro",
  "applicantstack",
  "homerun",
  "factorial",
  "eightfold",
  "successfactors",
  // Phase 6: per-company custom ATSes. Each is a single-tenant "ATS"
  // whose only "slug" is the company name. They are added as distinct
  // ATSIds (not a synthetic `custom` umbrella) so manifest.ats_counts,
  // observability, and the run-report carry the same per-vendor shape
  // as every other ATS.
  "amazonjobs",
  "applejobs",
  "tiktokcareers",
  "metacareers",
  // Vendor-agnostic JSON-LD harvester. Walks a per-tenant sitemap URL
  // and extracts `schema.org/JobPosting` JSON-LD blocks from each linked
  // page. Tenant identity = (slug, sitemap_url). The underlying careers
  // stack is opaque to the adapter; this unlocks brands whose stack is
  // proprietary but who serve Google-for-Jobs structured data anyway
  // (the TalentBrew-backed family — Lockheed Martin, AT&T, Comcast,
  // Marriott, Spectrum — being the first verified seed set).
  "jsonld",
  // IBM Kenexa / BrassRing Talent Suite. Multi-tenant ATS shared at
  // sjobs.brassring.com; tenant identity = (partnerid, siteid). CSRF-
  // token + cookie-session two-step API. Verified seeds: Publix,
  // Hobby Lobby, Harbor Freight Tools, Best Buy, HCL Technologies,
  // ADM, Performance Food Group, GardaWorld, Habitat for Humanity,
  // Helzberg, Yale University.
  "brassring",
  // Google for Jobs RSS feed harvester. Vendor-agnostic, like jsonld:
  // tenant identity = (slug, feed_url). The feed is an RSS 2.0 document
  // in the http://base.google.com/ns/1.0 namespace whose every <item>
  // is a complete job posting. Unlocks brands whose backend API is
  // robots-blocked (e.g. SuccessFactors `careersection`) but who
  // publish this open feed for Google ingestion. First verified seeds:
  // SAP, ExxonMobil (both SuccessFactors-backed, 0-role under the
  // successfactors adapter because the SF API is Disallow: /).
  "gjobsfeed",
  // Oracle Fusion HCM Candidate Experience. Multi-tenant enterprise ATS
  // whose public careers API is the documented Candidate Experience REST
  // resource `recruitingCEJobRequisitions` on a per-tenant Fusion pod.
  // Tenant identity = (host, site): the pod host
  // (`ejhp.fa.us6.oraclecloud.com`) plus the CE site code (`siteNumber`,
  // e.g. `CX_2`), exactly the two-field composite the workday adapter
  // uses. Single GET per page; the listing already carries the summary
  // blurb so no detail fan-out is needed. Verified seeds: Sherwin-Williams,
  // Vertiv, Ford, DTCC, Cantor Fitzgerald.
  "oraclecloud",
  // JazzHR (formerly The Resumator). Public hosted board at
  // `{slug}.applytojob.com/apply/` server-renders one link per role;
  // each job page carries schema.org/JobPosting JSON-LD (read via
  // jsonld-core). Tenant identity = slug (subdomain), so no metadata is
  // required. Eight verified seeds, including Marc Jacobs, Storyteller,
  // Industrial Fabricators, Brennan Center and Understory.
  "jazzhr",
  // Phenom ("Phenom People") personalised career sites. The search page
  // server-renders its first results window into a
  // `phApp.ddo.eagerLoadRefineSearch` object; `?from=N` paginates it.
  // Tenant identity = (host, locale): big customers serve from vanity
  // domains (careers.{brand}.com), so the host is operator-seeded and
  // SSRF-guarded rather than slug-derivable, like the jsonld harvester.
  // Verified seeds: Phenom, Southwest Airlines, Regions Bank.
  "phenom",
  // HRMDirect (ClearCompany) hosted boards. Public board at
  // `{slug}.hrmdirect.com/employment/job-openings.php` server-renders a
  // single table of every open role; the adapter parses that one page
  // (no detail fetch, no JSON-LD). Title + URL + id are uniform across
  // tenants; the optional location/department columns are per-tenant
  // configurable, so seeds favour the semantic-column layout. Tenant
  // identity = slug (subdomain), so no metadata is required. Verified
  // seeds: Energy Systems Group, USO, Jackson Walker, Preferred Mutual.
  "hrmdirect",
  // SchoolSpring, a K-12 education job platform: districts and schools
  // nationwide post to one shared board at www.schoolspring.com. Public
  // JSON API (`api.schoolspring.com/api/Jobs/GetPagedJobsWithSearch`),
  // single-tenant like the per-company customs above — but
  // multi-EMPLOYER: the company on each Job comes from the row's
  // `employer` field, not the tenant display name. ~100k live roles, so
  // the adapter reads the list payload only (no per-job detail
  // fan-out), with a large page size to keep the request count in the
  // single digits.
  "schoolspring",
  // isolved Hire hosted boards. Public board at `{slug}.isolvedhire.com/jobs/`
  // is a Vue SPA whose loader embeds a `courierCurrentRouteData` blob with
  // the per-tenant `domain_id`; `/core/jobs/{domainId}` then returns the
  // entire job list (title, city/state, workplace type, posting date, pay
  // range, canonical job URL) in one unpaginated call. The same board engine
  // also serves the `applicantpro.com` domain family (already covered by the
  // applicantpro adapter); this adapter covers only the `isolvedhire.com`
  // host. Tenant identity = slug (subdomain), so no metadata is required.
  // Verified seeds: Safe Tire & Auto, Davidson Oil, Flying Star Transport.
  "isolvedhire",
  // Frontline AppliTrack K-12 recruiting boards. Every district gets a
  // public board on the shared host `www.applitrack.com/{district}/…`;
  // the `onlineapp/jobpostings/Output.asp?all=1` endpoint streams a
  // JavaScript document of `document.write` calls whose concatenated
  // payloads are the full HTML for every open posting — one GET per
  // tenant, no pagination, no detail fetch. Tenant identity = the
  // district path slug, so no metadata is required. Verified seeds:
  // Caroline County Public Schools, Tredyffrin/Easttown School District,
  // Lucia Mar Unified School District.
  "applitrack",
  // HiringThing hosted job boards. Every customer board lives at
  // `{slug}.hiringthing.com` and publishes an RSS feed at `/api/rss.xml`
  // whose every <item> is a complete listing entry: title, deep link
  // (`/job/{id}/{title-slug}`, carrying the numeric job id), location,
  // and an HTML description — so a single GET per tenant covers the
  // whole board, no pagination, no per-job fan-out. The feed carries no
  // publish date, so posted_at is omitted (as with hrmdirect). Tenant
  // identity = slug (subdomain); no metadata is required. The platform
  // also links a global S3 sitemap of hosted boards from each board's
  // robots.txt, a useful discovery surface. White-label boards on
  // custom domains exist but are out of scope — slug boards only.
  // Verified seeds: Pinnacle, Greater SATX, Your SmartSource.
  "hiringthing",
  // Apploi job platform (healthcare-heavy multi-brand hiring). Every brand
  // shares one public search API at ats-integrations.apploi.com; the org
  // scope is the exact `brand` name string passed as a query parameter —
  // there is no URL-derivable slug. Tenant identity = (slug, metadata.brand):
  // an operator-chosen kebab slug plus the verbatim brand string the API
  // filters on. The `brand` parameter is a relevance search, not a strict
  // filter, so the adapter keeps only rows whose `brand_name` matches
  // exactly. Verified seeds: University Health, The Laurels of Blanchester,
  // Community Care Home Health Services - White Plains.
  "apploi",
  // Hirebridge hosted boards. Every customer board lives on the single
  // shared host `recruit.hirebridge.com`, selected by a numeric `cid`
  // query parameter — the tenant slug IS that cid string (no subdomain,
  // no metadata). The listing page (`/v3/jobs/list.aspx?cid={cid}`)
  // server-renders every open role on one page as location-grouped link
  // lists, so a single GET per tenant covers it (no pagination, no
  // detail fetch; the hbapi JSON search endpoint returns empty
  // title/url/date fields and only powers the filter dropdowns).
  // Verified seeds: Menard Inc, Rinker Materials, Avenue5 Residential.
  "hirebridge",
  // Taleo Business Edition (the SMB pool, distinct from the enterprise
  // `taleo` careersection stack). Every customer's public board is a
  // server-rendered page on a shared pod host:
  // `{pod}.tbe.taleo.net/{instance}/ats/careers/v2/searchResults?org={ORG}&cws={n}`.
  // Tenant identity is the composite (host, instance, cws) plus the org
  // code as slug — none of it derivable from the slug alone, so all
  // three metadata keys are mandatory (workday/oraclecloud convention).
  // Pagination (`&next&rowFrom=N`, 10 rows/page) requires echoing the
  // JSESSIONID the first page sets; without it every later page is
  // empty. Verified seeds: RealmOne, City of Burnaby, DT Global.
  "taleotbe",
  // Workstream hourly-hiring boards. Every tenant's public board lives on
  // the shared host `www.workstream.us` at `/j/{companyId}/{slug}/positions`,
  // server-rendering 10 role links per page (`?page=N` paginates); each job
  // page carries schema.org/JobPosting JSON-LD (read via jsonld-core).
  // Tenant identity = (company_id, slug): the 8-hex company id is mandatory
  // routing metadata because the board URL embeds both. Verified seeds:
  // Chick-fil-A, JOEY Restaurants, Wingstop, Burger King.
  "workstream",
  // CareerPlug hosted boards. Public board at `{slug}.careerplug.com/jobs`
  // server-renders paginated job cards (~30 per page via `?page=N`; a
  // `.pagination` nav exposes the last page number). Each card carries
  // the title, a `ST-City-ZIP` location and a post date, so jobs are
  // built from the listing alone — no per-job detail fetch (detail pages
  // redirect straight into the application flow). Tenant identity = slug
  // (subdomain), so no metadata is required; franchise brands commonly
  // run one subdomain per location. Verified seeds: Planet Fitness,
  // Crunch Fitness, i9 Sports.
  "careerplug",
  // Jibe hosted career sites. Public unauthenticated JSON at
  // `{host}/api/jobs?page=N&limit=100` returns `jobs[].data` rows plus a
  // `totalCount`; the full HTML description ships in the list payload, so
  // one paginated walk covers everything (no detail fetch). Tenant
  // identity = slug (board host `{slug}.jibeapply.com`); a few customers
  // serve the same API from a vanity CNAME, seeded via optional
  // `metadata.host` and SSRF-guarded like phenom's vanity domains. The
  // canonical public job URL is `{host}/jobs/{req_id}` — the payload's
  // `apply_url` leads to a login flow and is not used. Verified seeds:
  // Davidson Hospitality, Mount Sinai, FedEx Freight.
  "jibeapply",
  // Hireology hosted career sites. Every tenant is a path slug on the
  // shared SPA host (`careers.hireology.com/{slug}`); the SPA is backed
  // by a public JSON API at `api.hireology.com/v2/public/careers/{slug}`
  // returning `{ data: [...], count }` with page/page_size pagination.
  // The listing already carries the full HTML job description, so one
  // GET per page covers everything — no detail fan-out. Tenant identity
  // = slug (no metadata required). Verified seeds: three Home Instead
  // franchise boards.
  "hireology",
  // ApplicantPool hosted boards. The same Vue board engine as isolvedhire /
  // applicantpro, on the `{slug}.applicantpool.com` host: the public board at
  // `/jobs/` embeds a `courierCurrentRouteData` blob with the per-tenant
  // `domain_id`; `/core/jobs/{domainId}` then returns the entire job list
  // (title, city/state, workplace type, posting date, pay range, canonical
  // job URL) in one unpaginated call. The platform publishes a live-tenant
  // sitemap at feeds.applicantpool.com/site_map_index.xml — a discovery
  // surface the applicantpro adapter's `.applicantpro.com` host never reaches.
  // Tenant identity = slug (subdomain), so no metadata is required. Verified
  // seeds: Scientific Drilling, Travel Portland, First Federal.
  "applicantpool",
  // PageUp hosted careers boards. Public board is server-rendered HTML at
  // `{host}/{instance}/{clientkey}/en/listing/`, where `host` is one of the
  // shared PageUp career hosts (`careers` / `careersmanager` /
  // `careersite`.pageuppeople.com), `instance` is the numeric pod id and
  // `clientkey` is the customer code. A clientkey is NOT globally unique —
  // demo keys like `caw`/`cw` recur across many instances — so tenant
  // identity is the composite `{instance}-{clientkey}` slug plus mandatory
  // `host` + `instance` + `clientkey` metadata (the workday/taleotbe
  // convention). None of the three is slug-derivable, so a tenant missing
  // any is marked dead. The listing carries title, deep link (id + slug) and
  // location per row; it exposes only an application close-date, never a
  // posting date, so posted_at is never emitted. Pagination is `?page=N`,
  // walked until a page yields no fresh job ids. Verified seeds: Just Group
  // (438/caw), PageUp demo (959/cw), Compass Group Education (541/ce).
  "pageup",
  // Manatal hosted career boards. Every customer board lives on the single
  // shared host `www.careers-page.com` at `/{slug}`, which server-renders a
  // flat list of `<a href="/{slug}/job/{code}">` links — one per open role.
  // There is no list JSON endpoint, so the board HTML is parsed for the job
  // codes and each detail page (`/{slug}/job/{code}`) is fetched for its one
  // `schema.org/JobPosting` JSON-LD block (emitted for Google for Jobs), read
  // via jsonld-core. Tenant identity = slug (the first path segment); a dead
  // or unknown slug answers a clean HTTP 404, so no metadata is required.
  // Verified seeds: Manatal, BLR WORLD, GAP Recruitment Services.
  "manatal",
  // Rippling hosted ATS boards. Every tenant's public board lives at
  // `ats.rippling.com/{slug}/jobs`, backed by an unauthenticated JSON API on
  // `api.rippling.com`: the list resource
  // `/platform/api/ats/v1/board/{slug}/jobs` returns a top-level array of
  // roles (uuid, title, department, workLocation, canonical url) in one
  // unpaginated call, and the detail resource
  // `/platform/api/ats/v1/board/{slug}/jobs/{uuid}` adds the HTML description,
  // `createdOn` post date, `workLocations`, `employmentType`, `companyName`
  // and `payRangeDetails`. Because the list carries no date or description,
  // the adapter fans out a bounded, concurrency-limited detail GET per role to
  // populate posted_at + excerpt + pay. Tenant identity = the URL path slug,
  // so no metadata is required. Verified seeds: routeware-careers,
  // talentneuroncareers, fifth-season-careers.
  "rippling",
] as const);

export type ATSId = (typeof ATS_IDS)[number];

export const ATSIdSchema = z.enum([...ATS_IDS]);
