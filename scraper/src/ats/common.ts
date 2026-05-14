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
// The host-string check is deliberately conservative: we don't try to
// resolve DNS or reason about IPv6 — operator-curated seeds are the
// only callers today, but treating the guard as defence-in-depth
// matters because tenant records can flow in via untrusted harvest
// channels in the future.
export function isSafeFetchHost(parsed: URL): boolean {
  if (parsed.protocol !== "https:") return false;
  const host = parsed.host.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  // AWS / GCP / Azure instance-metadata
  if (host === "169.254.169.254" || host === "metadata.google.internal") return false;
  // Naive RFC1918 + link-local + loopback IPv4 check. We don't accept
  // any literal IP for production careers URLs; if a future legitimate
  // tenant ever needs one, narrow the deny list rather than widening
  // the allow list.
  if (/^(?:10|127|0)\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  return true;
}
