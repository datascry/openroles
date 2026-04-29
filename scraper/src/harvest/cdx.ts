import type { ATSId } from "@openroles/shared";
import { type AtsHarvestPattern, harvestPatternFor } from "./patterns.ts";

export interface CdxRecord {
  readonly url: string;
  readonly status: string;
  readonly timestamp: string;
}

export function parseCdxJsonLines(body: string): CdxRecord[] {
  const out: CdxRecord[] = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const r = parsed as Record<string, unknown>;
    const url = r["url"];
    const status = r["status"];
    const timestamp = r["timestamp"];
    if (typeof url !== "string") continue;
    out.push({
      url,
      status: typeof status === "string" ? status : "",
      timestamp: typeof timestamp === "string" ? timestamp : "",
    });
  }
  return out;
}

export interface SlugExtraction {
  readonly ats: ATSId;
  readonly slugs: ReadonlyArray<string>;
  // First-seen metadata per slug, populated only when the pattern's
  // `extractMetadata` hook returns something for that match. A slug whose
  // first appearance has no metadata stays unmetadata'd even if a later
  // appearance would; subsequent appearances never *override* metadata
  // either, to keep the harvest output deterministic when CDX rows arrive
  // in different orders across runs.
  readonly metadata: ReadonlyMap<string, Record<string, string>>;
}

export function extractSlugs(
  records: ReadonlyArray<CdxRecord>,
  pattern: AtsHarvestPattern,
): SlugExtraction {
  // Fresh RegExp per call so concurrent extractions cannot race on the
  // shared `lastIndex` of the pattern's regex.
  const re = new RegExp(pattern.regex.source, pattern.regex.flags);
  const seen = new Set<string>();
  const metadata = new Map<string, Record<string, string>>();
  for (const r of records) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null = re.exec(r.url);
    while (m !== null) {
      const slug = (m[1] ?? m[2] ?? "").toLowerCase();
      if (slug.length > 0 && !pattern.denyList.has(slug)) {
        seen.add(slug);
        if (pattern.extractMetadata && !metadata.has(slug)) {
          const meta = pattern.extractMetadata(m);
          if (meta) metadata.set(slug, meta);
        }
      }
      m = re.exec(r.url);
    }
  }
  return { ats: pattern.ats, slugs: Array.from(seen).sort(), metadata };
}

export function buildCdxUrl(snapshot: string, query: string, page: number = 0): string {
  const params = new URLSearchParams({
    url: query,
    output: "json",
    fl: "url,status,timestamp",
    page: String(page),
  });
  return `https://index.commoncrawl.org/CC-MAIN-${encodeURIComponent(snapshot)}-index?${params.toString()}`;
}

export function buildCdxNumPagesUrl(snapshot: string, query: string): string {
  const params = new URLSearchParams({ url: query, showNumPages: "true" });
  return `https://index.commoncrawl.org/CC-MAIN-${encodeURIComponent(snapshot)}-index?${params.toString()}`;
}

export function parseNumPages(body: string): number {
  const trimmed = body.trim();
  const direct = Number.parseInt(trimmed, 10);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  try {
    const json = JSON.parse(trimmed) as unknown;
    if (typeof json === "object" && json !== null) {
      const n = (json as Record<string, unknown>)["pages"];
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) return n;
    }
  } catch {
    // fall through
  }
  return 0;
}

export const SNAPSHOT_ID_RE: RegExp = /^\d{4}-\d{2}$/;

export function harvestPlanFor(
  ats: ATSId,
  snapshots: ReadonlyArray<string>,
): {
  readonly pattern: AtsHarvestPattern;
  readonly urls: ReadonlyArray<string>;
} {
  const pattern = harvestPatternFor(ats);
  const urls = snapshots.map((s) => buildCdxUrl(s, pattern.cdxQuery));
  return { pattern, urls };
}
