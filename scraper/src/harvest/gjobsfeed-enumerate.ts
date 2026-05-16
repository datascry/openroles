import { SLUG_PATTERN } from "./patterns.ts";

// Common Crawl columnar-index enumeration for gjobsfeed candidates.
// See specs/gjobsfeed-cc-enumeration.md. This module is pure parsing +
// transformation; the heavyweight DuckDB-over-S3 scan is shelled out
// by the CLI command and is the operator's (paid) call.

// Career-site subdomain labels we strip when deriving a brand slug
// from a host. Must match the regexp the SQL filter uses.
const CAREER_PREFIXES = new Set(["jobs", "careers", "job", "career", "recruiting", "talent"]);

// Public suffixes that span two labels. Not exhaustive — the long tail
// is operator-reviewed and the probe/dedup guard still gate every
// candidate, so a missed multi-label suffix only yields a slightly-off
// slug for a rare host, never a corruption.
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk",
  "com.au",
  "co.jp",
  "co.nz",
  "com.br",
  "co.in",
  "com.mx",
  "co.za",
  "com.sg",
]);

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Derive a brand slug from a career-site host.
 *
 *   jobs.sap.com            -> "sap"
 *   careers.molsoncoors.com -> "molsoncoors"
 *   jobs.foo.co.uk          -> "foo"
 *
 * Returns null when the host is malformed, an IP literal, has no
 * registrable label, or the derived slug fails SLUG_PATTERN.
 */
export function deriveSlug(host: string): string | null {
  const h = host.trim().toLowerCase();
  if (h.length === 0) return null;
  if (h.includes(":")) return null; // IPv6 literal / host:port
  if (IPV4.test(h)) return null;
  if (!/^[a-z0-9.-]+$/.test(h)) return null;
  const labels = h.split(".").filter((l) => l.length > 0);
  if (labels.length !== h.split(".").length) return null; // leading/trailing/double dot
  if (labels.length < 2) return null;

  let parts = labels;
  // Strip a leading careers-prefix label whenever present. Using >=2
  // (not >2) so `jobs.com` collapses to `[com]` → null rather than
  // mis-deriving the prefix word itself as the brand slug.
  if (parts.length >= 2 && parts[0] !== undefined && CAREER_PREFIXES.has(parts[0])) {
    parts = parts.slice(1);
  }
  if (parts.length < 2) return null;
  const lastTwo = parts.slice(-2).join(".");
  const suffixLen = TWO_LABEL_SUFFIXES.has(lastTwo) ? 2 : 1;
  const registrableIdx = parts.length - suffixLen - 1;
  if (registrableIdx < 0) return null;
  const slug = parts[registrableIdx];
  if (slug === undefined || !SLUG_PATTERN.test(slug)) return null;
  return slug;
}

/**
 * Parse `duckdb -csv -c "..."` stdout into a host list. The first line
 * is the `url_host_name` header. Tolerant of CRLF, surrounding double
 * quotes, blank lines, and a trailing newline.
 */
export function parseDuckdbHostRows(stdout: string): string[] {
  const out: string[] = [];
  const lines = stdout.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const line = raw.trim();
    if (line.length === 0) continue;
    if (i === 0 && line.replace(/"/g, "") === "url_host_name") continue; // header
    const host = line.replace(/^"(.*)"$/, "$1").trim();
    if (host.length > 0) out.push(host);
  }
  return out;
}

export interface GjobsfeedCandidate {
  readonly slug: string;
  readonly display_name: string;
  readonly hosts: ReadonlyArray<string>;
}

function titleize(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w.length > 0 ? w[0]?.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export interface MergeResult {
  readonly candidates: GjobsfeedCandidate[];
  readonly added: number;
  readonly hostsAddedToExisting: number;
  readonly skipped: number;
}

/**
 * Merge enumerated hosts into the existing candidate list:
 * - a host whose derived slug is new becomes a fresh candidate
 *   (display_name titleised from the slug — operator may refine);
 * - a host whose slug already exists is unioned into that candidate's
 *   `hosts` (so a brand reachable at jobs.X and careers.X is probed at
 *   both) without touching its display_name;
 * - hosts that fail `deriveSlug` are skipped and counted.
 *
 * Pure, deterministic, stable-sorted by slug. Existing entries are
 * preserved (idempotent: re-running with the same hosts is a no-op).
 */
export function mergeCandidates(
  existing: ReadonlyArray<GjobsfeedCandidate>,
  hosts: ReadonlyArray<string>,
): MergeResult {
  const bySlug = new Map<string, { display_name: string; hosts: Set<string> }>();
  for (const c of existing) {
    bySlug.set(c.slug, { display_name: c.display_name, hosts: new Set(c.hosts) });
  }
  let added = 0;
  let hostsAddedToExisting = 0;
  let skipped = 0;
  for (const host of hosts) {
    const slug = deriveSlug(host);
    if (slug === null) {
      skipped += 1;
      continue;
    }
    const norm = host.trim().toLowerCase();
    const cur = bySlug.get(slug);
    if (cur === undefined) {
      bySlug.set(slug, { display_name: titleize(slug), hosts: new Set([norm]) });
      added += 1;
    } else if (!cur.hosts.has(norm)) {
      cur.hosts.add(norm);
      hostsAddedToExisting += 1;
    }
  }
  const candidates = [...bySlug.entries()]
    .map(([slug, v]) => ({
      slug,
      display_name: v.display_name,
      hosts: [...v.hosts].sort(),
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  return { candidates, added, hostsAddedToExisting, skipped };
}

/**
 * Build the DuckDB SQL for one CC-MAIN crawl. The crawl id is
 * validated by the caller (CLI) against the CC-MAIN id shape before
 * it reaches here, but we re-assert the shape so the string can never
 * carry an injection even if a future caller forgets.
 */
export function buildEnumerationSql(crawl: string): string {
  if (!/^CC-MAIN-\d{4}-\d{2}$/.test(crawl)) {
    throw new Error(`invalid crawl id: ${JSON.stringify(crawl)}`);
  }
  const loc = `s3://commoncrawl/cc-index/table/cc-main/warc/crawl=${crawl}/subset=warc/*.parquet`;
  return [
    "INSTALL httpfs; LOAD httpfs;",
    "SET s3_region='us-east-1'; SET s3_endpoint='s3.amazonaws.com';",
    "SELECT DISTINCT url_host_name FROM read_parquet('",
    loc,
    "') WHERE url_path = '/sitemap.xml' AND fetch_status = 200 ",
    "AND regexp_matches(url_host_name, '^(jobs|careers|job|career|recruiting|talent)\\.');",
  ].join("");
}
