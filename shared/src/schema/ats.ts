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
] as const);

export type ATSId = (typeof ATS_IDS)[number];

export const ATSIdSchema = z.enum([...ATS_IDS]);
