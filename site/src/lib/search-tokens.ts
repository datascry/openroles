// Client-side stem-aware search via the inverted index emitted by
// scraper/src/db/search-index.ts. Lazy-loaded only when the user
// types in the search box — avoids paying the ~2 MB bandwidth cost
// for users who only browse / filter.
//
// Match algorithm:
//   1. Tokenise + stem the query the same way the build did
//   2. Look up each stem's posting list (delta-decoded)
//   3. Intersect the lists (rows that contain ALL query stems)
//   4. Return the intersection as a Set<rowIndex>
//
// The rowIndex space matches the order of rows in the concatenated
// slim-index chunks (which the build sorts by posted_at DESC NULLS LAST
// then first_seen_at DESC). The FilterTable maps Set<rowIndex> → row
// short_ids by indexing into its `slimIndex.rows` array.

const TOKEN_RE = /[a-z0-9]+/g;

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "for",
  "to",
  "in",
  "on",
  "at",
  "by",
  "with",
  "as",
  "is",
  "be",
  "are",
  "was",
  "were",
  "from",
  "into",
  "this",
  "that",
  "it",
  "its",
  "we",
  "you",
  "our",
  "your",
]);

export function tokenize(text: string): string[] {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "") // strip combining diacriticals
      .match(TOKEN_RE) ?? []
  );
}

/**
 * Same Porter-1-lite stemmer as scraper/src/db/search-index.ts. Kept
 * deliberately conservative — we only collapse the suffixes that
 * matter for job-title search (verb forms, plurals, -er agent
 * suffix). No -or / -ist rules because they bite back on common
 * job-title terms like "senior" → "seni" which trashes search
 * matching for the most common keyword in the corpus.
 */
export function stem(token: string): string {
  if (token.length <= 3) return token;
  let t = token;
  if (t.endsWith("sses")) t = t.slice(0, -2);
  else if (t.endsWith("ies")) t = `${t.slice(0, -3)}i`;
  else if (t.endsWith("s") && !t.endsWith("ss") && t.length > 4) t = t.slice(0, -1);
  if (t.endsWith("ing") && t.length > 5) t = t.slice(0, -3);
  else if (t.endsWith("ed") && t.length > 4) t = t.slice(0, -2);
  if (t.endsWith("er") && t.length > 4) t = t.slice(0, -2);
  if (t.endsWith("e") && t.length > 4) t = t.slice(0, -1);
  return t;
}

/**
 * Convert a free-text query into the deduplicated set of stems we'll
 * look up against the inverted index. Stop words and stems shorter
 * than 2 chars are dropped.
 */
export function queryStems(q: string): string[] {
  const out = new Set<string>();
  for (const tok of tokenize(q)) {
    if (STOP_WORDS.has(tok)) continue;
    const s = stem(tok);
    if (s.length >= 2) out.add(s);
  }
  return [...out];
}

export interface SearchIndex {
  /** Total rows the postings reference. */
  readonly total: number;
  /** stem → sorted ascending row indices (delta-decoded already). */
  readonly postings: Map<string, ReadonlyArray<number>>;
}

/**
 * Decode the wire format. `s` is comma-separated base-36 deltas.
 *
 *   "0,3,1,5"  →  [0, 3, 4, 9]
 *
 * Empty or single-token stems are tolerated; an empty string yields
 * an empty array.
 */
export function decodePostingList(encoded: string): number[] {
  if (encoded.length === 0) return [];
  const parts = encoded.split(",");
  const out: number[] = new Array(parts.length);
  let prev = 0;
  for (let i = 0; i < parts.length; i++) {
    const delta = Number.parseInt(parts[i] ?? "", 36);
    if (!Number.isFinite(delta)) return out.slice(0, i);
    prev += delta;
    out[i] = prev;
  }
  return out;
}

/**
 * Parse the on-wire JSON payload into an in-memory inverted index.
 * Throws on malformed input — callers should catch and degrade to the
 * substring-only search path.
 */
export function parseSearchIndex(raw: unknown): SearchIndex {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("parseSearchIndex: expected an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj["n"] !== "number") {
    throw new Error("parseSearchIndex: missing/invalid n field");
  }
  const stemsRaw = obj["stems"];
  if (typeof stemsRaw !== "object" || stemsRaw === null || Array.isArray(stemsRaw)) {
    throw new Error("parseSearchIndex: stems must be an object");
  }
  const postings = new Map<string, ReadonlyArray<number>>();
  for (const [key, val] of Object.entries(stemsRaw as Record<string, unknown>)) {
    if (typeof val !== "string") continue;
    postings.set(key, decodePostingList(val));
  }
  return { total: obj["n"], postings };
}

/**
 * Run a stem-AND search: return the set of row indices whose title or
 * company contains all query stems. Empty query → null (caller should
 * fall through to the unfiltered path).
 */
export function searchStems(index: SearchIndex, q: string): Set<number> | null {
  const stems = queryStems(q);
  if (stems.length === 0) return null;

  // Pull each stem's posting list. Any missing stem means zero results.
  const lists: ReadonlyArray<number>[] = [];
  for (const s of stems) {
    const list = index.postings.get(s);
    if (!list) return new Set();
    lists.push(list);
  }
  // Intersect the smallest list against the rest.
  lists.sort((a, b) => a.length - b.length);
  const seed = lists[0];
  if (!seed) return new Set();
  let candidates = new Set<number>(seed);
  for (let i = 1; i < lists.length; i++) {
    const next = new Set<number>();
    const list = lists[i];
    if (!list) continue;
    for (const idx of list) {
      if (candidates.has(idx)) next.add(idx);
    }
    candidates = next;
    if (candidates.size === 0) break;
  }
  return candidates;
}
