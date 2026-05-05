/**
 * Pure helpers extracted from `RoleDetail.svelte` so they can be unit-tested.
 * The component itself only renders; this file owns:
 *   - freshness tag derivation (FRESH / ACTIVE / muted / FIRST SEEN fallback)
 *   - date formatting helpers
 *   - body / strap / dropcap segmentation
 *   - URL-side short-id extraction
 */

const SHORT_ID_RE = /^[0-9a-f]{16}$/;
const PATH_SHORT_ID_RE = /\/role\/([0-9a-f]{16})\/?$/i;

export function shortIdFromUrl(search: string, pathname: string): string | null {
  const params = new URLSearchParams(search);
  const fromQuery = params.get("id") ?? params.get("short_id");
  if (fromQuery && SHORT_ID_RE.test(fromQuery)) return fromQuery;
  const m = PATH_SHORT_ID_RE.exec(pathname);
  if (m?.[1]) return m[1].toLowerCase();
  return null;
}

export type FreshnessTone = "fresh" | "active" | "muted";
export interface FreshnessTag {
  readonly tone: FreshnessTone;
  readonly text: string;
}

/**
 * Map a role's `posted_at` (or `first_seen_at` fallback) to the rail-top
 * freshness tag. `now` is injectable for tests.
 *
 * Spec §3.5:
 *   stale     → "LAST SEEN {date} · STALE" (muted) — the role was carried
 *               forward from a previous build and not observed today.
 *               Overrides the posted_at-based tone so a stale role doesn't
 *               misleadingly read "ACTIVE" because its posted_at is recent.
 *   ≤ 7 days  → FRESH (accent)
 *   ≤ 30 days → ACTIVE (ink)
 *   older     → "{N} DAYS AGO" (muted)
 *   no posted_at → "FIRST SEEN {date}" (muted)
 */
export function freshnessTag(
  postedAt: string | null,
  firstSeenAt: string,
  options: { now?: number; isStale?: boolean; lastSeenAt?: string } = {},
): FreshnessTag {
  const now = options.now ?? Date.now();
  if (options.isStale) {
    const lastSeen = options.lastSeenAt ?? firstSeenAt;
    return { tone: "muted", text: `LAST SEEN ${shortDate(lastSeen)} · STALE` };
  }
  if (postedAt !== null) {
    const t = Date.parse(postedAt);
    if (Number.isNaN(t)) return { tone: "muted", text: `POSTED ${shortDate(postedAt)}` };
    const days = Math.floor((now - t) / 86_400_000);
    if (days <= 7) return { tone: "fresh", text: `POSTED ${shortDate(postedAt)} · FRESH` };
    if (days <= 30) return { tone: "active", text: `POSTED ${shortDate(postedAt)} · ACTIVE` };
    return { tone: "muted", text: `POSTED ${shortDate(postedAt)} · ${days} DAYS AGO` };
  }
  if (firstSeenAt) return { tone: "muted", text: `FIRST SEEN ${shortDate(firstSeenAt)}` };
  return { tone: "muted", text: "FIRST SEEN —" };
}

const MONTHS_SHORT = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
] as const;

/**
 * Format an ISO date as `DD MMM` in en-US uppercase. UTC components are used
 * so the output is timezone-stable across the build/CI machine and the
 * user's browser (otherwise an Apr 22 UTC role can render as "21 APR" in
 * Pacific time).
 */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = MONTHS_SHORT[d.getUTCMonth()] ?? "";
  return `${day} ${month}`;
}

export function relativeDays(iso: string | null, now: number = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const days = Math.floor((now - t) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" });
}

/**
 * Pull the first sentence out of a description excerpt for the strap. If
 * the sentence already ends with `.!?` keep it; otherwise append a period.
 */
export function strapText(excerpt: string | null): string {
  if (!excerpt) return "";
  const firstSentence = excerpt.split(/[.!?]\s/)[0] ?? "";
  if (firstSentence.length === 0) return "";
  return /[.!?]$/.test(firstSentence) ? firstSentence : `${firstSentence}.`;
}

/**
 * Split the description excerpt into trimmed paragraphs on blank-line
 * boundaries. Filters out empty entries.
 */
export function bodyParas(excerpt: string | null): ReadonlyArray<string> {
  if (!excerpt) return [];
  return excerpt
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Split a paragraph into the first grapheme (the dropcap glyph) and the
 * rest of the paragraph. Uses `Array.from` so emoji / surrogate pairs are
 * preserved as a single visual unit.
 */
export function dropcap(p: string): { first: string; rest: string } {
  if (p.length === 0) return { first: "", rest: "" };
  const codepoints = Array.from(p);
  const first = codepoints[0] ?? "";
  const rest = codepoints.slice(1).join("");
  return { first, rest };
}
