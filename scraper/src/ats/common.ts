import { classifyRecruiter, type Job, type TenantResult } from "@openroles/shared";
import { HttpError } from "../http.ts";

const SAFE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function assertSafeSlug(slug: string): void {
  if (!SAFE_SLUG.test(slug)) {
    throw new HttpError("permanent", `tenant slug rejected: ${JSON.stringify(slug)}`);
  }
}

const WORKDAY_HOST = /^[a-z0-9-]{1,64}\.wd\d{1,3}(?:-[a-z0-9]+)?\.myworkdayjobs\.com$/;

export function assertWorkdayHost(host: string): void {
  if (!WORKDAY_HOST.test(host)) {
    throw new HttpError("permanent", `workday host rejected: ${JSON.stringify(host)}`);
  }
}

const WORKDAY_SITE = /^[A-Za-z0-9_-]{1,64}$/;

export function assertWorkdaySite(site: string): void {
  if (!WORKDAY_SITE.test(site)) {
    throw new HttpError("permanent", `workday site rejected: ${JSON.stringify(site)}`);
  }
}

// Oracle Fusion HCM Candidate Experience pods. The careers host is a
// per-tenant Fusion pod under `*.fa[.region].oraclecloud.com` — e.g.
// `ejhp.fa.us6.oraclecloud.com`, `jpmc.fa.oraclecloud.com`,
// `fa-eups-saasfaprod1.fa.ocs.oraclecloud.com`. Anchoring to the
// `oraclecloud.com` suffix is the SSRF guard: a tenant-supplied host can
// only ever address an Oracle pod, never an arbitrary origin.
const ORACLE_HOST = /^[a-z0-9-]{1,40}\.fa\.(?:[a-z0-9-]{1,20}\.){0,3}oraclecloud\.com$/;

export function assertOracleHost(host: string): void {
  if (!ORACLE_HOST.test(host)) {
    throw new HttpError("permanent", `oraclecloud host rejected: ${JSON.stringify(host)}`);
  }
}

// Candidate Experience site code — the `siteNumber` that selects which
// public career site on the pod to read (`CX`, `CX_2`, `CX_1003`,
// `jobsearch`, `ULSolutionsCareers`, …). Alphanumeric + underscore only;
// it flows into both the REST `finder` expression and the job-card URL.
const ORACLE_SITE = /^[A-Za-z0-9_]{1,64}$/;

export function assertOracleSite(site: string): void {
  if (!ORACLE_SITE.test(site)) {
    throw new HttpError("permanent", `oraclecloud site rejected: ${JSON.stringify(site)}`);
  }
}

// Taleo Business Edition pods. Every TBE customer board lives on a shared
// pod host under `*.tbe.taleo.net` (e.g. `phh.tbe.taleo.net`,
// `tre.tbe.taleo.net`). Anchoring to the `.tbe.taleo.net` suffix is the
// SSRF guard: a tenant-supplied host can only ever address a TBE pod,
// never an arbitrary origin. Lowercase only — metadata is stored lowercase
// and a mixed-case host would dodge string-comparison checks downstream.
const TALEOTBE_HOST = /^[a-z0-9-]{1,32}\.tbe\.taleo\.net$/;

export function assertTaleoTbeHost(host: string): void {
  if (!TALEOTBE_HOST.test(host)) {
    throw new HttpError("permanent", `taleotbe host rejected: ${JSON.stringify(host)}`);
  }
}

// TBE pod instance — the first path segment of every careers URL on the
// pod (`phh03`, `tre01`, `lde01`). A single alphanumeric token; anything
// else would inject extra path segments into the request URL.
const TALEOTBE_INSTANCE = /^[a-z0-9]{1,32}$/;

export function assertTaleoTbeInstance(instance: string): void {
  if (!TALEOTBE_INSTANCE.test(instance)) {
    throw new HttpError("permanent", `taleotbe instance rejected: ${JSON.stringify(instance)}`);
  }
}

// TBE career-website selector (`cws`) — a small numeric id that picks
// which of the org's published career sites to read. Digits only; it
// flows into the query string of every request.
const TALEOTBE_CWS = /^[0-9]{1,6}$/;

export function assertTaleoTbeCws(cws: string): void {
  if (!TALEOTBE_CWS.test(cws)) {
    throw new HttpError("permanent", `taleotbe cws rejected: ${JSON.stringify(cws)}`);
  }
}

export function dedupeById(jobs: Job[]): Job[] {
  const seen = new Set<string>();
  const out: Job[] = [];
  for (const j of jobs) {
    if (!seen.has(j.id)) {
      seen.add(j.id);
      out.push(j);
    }
  }
  return out;
}

export function errorToResult(slug: string, err: unknown): TenantResult {
  if (err instanceof HttpError) {
    const status: TenantResult["status"] = err.kind === "transient" ? "transient_failure" : "dead";
    return {
      slug,
      status,
      ...(err.status !== undefined ? { http_status: err.status } : {}),
      error: err.message,
      jobs_count: 0,
    };
  }
  return {
    slug,
    status: "dead",
    error: err instanceof Error ? err.message : "unknown error",
    jobs_count: 0,
  };
}

export function isRecruiterTitle(title: string): boolean {
  return classifyRecruiter({ title });
}

export function epochToIso(epochMs: number | undefined): string | undefined {
  if (epochMs === undefined) return undefined;
  if (!Number.isFinite(epochMs)) return undefined;
  return new Date(epochMs).toISOString();
}

// Normalize a vendor-supplied date string to the canonical Z-suffixed UTC ISO
// shape JobSchema enforces. Greenhouse and others return `2026-03-11T17:29:19-04:00`
// (with timezone offset) — `Date.toISOString()` converts to UTC + Z. Returns
// undefined for missing or unparseable input.
export function vendorDateToIsoZ(value: string | null | undefined): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

// Cross-cutting SSRF guard for tenant-supplied URLs that flow into HTTP
// requests. Centralised here so probe builders and scrape orchestrators
// apply the same rejection rules — the asymmetry between the two paths
// was the audit finding M-2 in the jsonld harvester review. Returns
// true only for URLs we're willing to fetch from a tenant record.
//
// Rules:
// - HTTPS only (no http, no other protocols)
// - Reject loopback / link-local / private-suffix hostnames that should
//   never appear in a public-facing careers URL: localhost, *.localhost,
//   *.local, *.internal, AWS instance-metadata `169.254.169.254`, and
//   the RFC1918 private IPv4 ranges (10/8, 172.16/12, 192.168/16).
//
// The host-string check is deliberately conservative: we don't resolve
// DNS. Operator-curated seeds are the only callers today, but the guard
// is treated as defence-in-depth because tenant records can flow in via
// untrusted harvest channels in the future.
//
// Production careers feeds are always DNS hostnames, never raw IPs, so
// the guard rejects *every* IP literal — IPv4 and IPv6 alike. This is
// stricter than an RFC1918 deny list and closes the IPv6 bypass
// (`[::1]`, `[::ffff:169.254.169.254]`, `[fd00::1]`) that a
// range-based check leaves open. If a future legitimate tenant ever
// needs a literal IP, narrow this rather than widen the allow list.
export function isSafeFetchHost(parsed: URL): boolean {
  if (parsed.protocol !== "https:") return false;
  // `hostname` (not `host`) strips the port and the IPv6 brackets, so
  // `[::1]:443` → `::1`. Any colon in a URL hostname is an IPv6 literal
  // (DNS labels never contain `:`).
  const hostname = parsed.hostname.toLowerCase();
  if (hostname.includes(":")) return false; // IPv6 literal (any form)
  // Dotted-quad IPv4 literal — reject regardless of range. A bare
  // 4-octet host is never a real careers domain.
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;
  if (hostname.endsWith(".local") || hostname.endsWith(".internal")) return false;
  if (hostname === "metadata.google.internal") return false;
  return true;
}
