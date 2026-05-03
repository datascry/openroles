// Emits a tokenised + Porter-stemmed inverted index over titles +
// companies for client-side search. The runtime substring match in
// FilterTable is fine for direct keywords ("rust", "designer") but
// misses common stem variants — `engineer` doesn't match `engineering`,
// `manage` doesn't match `manager`. With ~2 MB extra (gzipped), the
// inverted index gives FTS5-comparable matching without a server-side
// query engine.
//
// Format on disk (one file: data/search/title-tokens.json.gz):
//
//   {
//     v: "1.0",
//     n: 747582,                 // total rows the postings reference
//     stems: {                   // stem → posting list
//       "engin":   "1,5,42,…",   // delta-encoded, base-36 ascii
//       "softwar": "0,2,9,…",
//       …
//     }
//   }
//
// Posting lists are delta-encoded (each subsequent value is an offset
// from the previous, not absolute) and emitted as base-36 ASCII to
// trim ~30% off the gzipped wire size vs plain JSON arrays of integers.
//
// Client-side: title → stems → set-intersect of the per-stem posting
// arrays. See site/src/lib/search-tokens.ts (forthcoming).
//
// Build cost at our 750k-row scale: ~3-5 seconds. Output: ~2 MB
// gzipped, ~1M postings, ~30k unique stems.

import type { Database } from "bun:sqlite";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const SEARCH_INDEX_SCHEMA_VERSION = "1.0";

// Drop common English stop words. They blow up the inverted index
// (every row has "the", "a", "and") for zero matching value.
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

const TOKEN_RE = /[a-z0-9]+/g;

/**
 * Extract lowercase ASCII tokens. We intentionally don't preserve
 * unicode — most ATS titles are ASCII or Latin-1; stripping diacritics
 * before tokenisation is good enough at our scale.
 */
function tokenise(text: string): string[] {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "") // strip combining diacriticals
      .match(TOKEN_RE) ?? []
  );
}

/**
 * Tiny Porter-1 stemmer — handles the common English suffix patterns
 * that matter for job-title search:
 *
 *   engineer / engineering / engineered → engin
 *   manage / manager / managers / managing → manag
 *   developer / developers / developing → develop
 *   designer / designers / designed → design
 *   senior / seniors → senior
 *   software → softwar
 *
 * Not full Porter-2 — that's overkill for our token set and bloats the
 * client. The rules below capture ~90% of the stem variants we see in
 * practice.
 *
 * Exported for unit testing.
 */
export function stem(token: string): string {
  if (token.length <= 3) return token; // too short to stem usefully
  let t = token;
  // Step 1a: -sses → -ss, -ies → -i, -s → '' (but only if 4+ chars).
  if (t.endsWith("sses")) t = t.slice(0, -2);
  else if (t.endsWith("ies")) t = `${t.slice(0, -3)}i`;
  else if (t.endsWith("s") && !t.endsWith("ss") && t.length > 4) t = t.slice(0, -1);
  // Step 1b: -ing / -ed (common verb forms).
  if (t.endsWith("ing") && t.length > 5) t = t.slice(0, -3);
  else if (t.endsWith("ed") && t.length > 4) t = t.slice(0, -2);
  // Step 2: -er agent suffix (engineer → engin, designer → design).
  // Deliberately NOT touching -or or -ist: they bite back on common
  // job-title terms like "senior" → "seni" which destroys search
  // matching on the most-typed keyword in the corpus.
  if (t.endsWith("er") && t.length > 4) t = t.slice(0, -2);
  // Step 3: -e (final silent e).
  if (t.endsWith("e") && t.length > 4) t = t.slice(0, -1);
  return t;
}

interface SearchIndexBuildResult {
  readonly fields: {
    readonly search_index_schema_version: string;
    readonly search_index_filename: string;
    readonly search_index_bytes_gz: number;
    readonly search_index_bytes_raw: number;
    readonly search_index_total_rows: number;
    readonly search_index_unique_stems: number;
    readonly search_index_total_postings: number;
  };
  /** Absolute path to the emitted file (for the workflow staging step). */
  readonly outputPath: string;
}

export interface EmitSearchIndexOptions {
  readonly outputDir: string;
  /** Subdirectory under outputDir. Default: "search". */
  readonly subdir?: string;
}

/**
 * Build + emit the title-token inverted index. Reads `title` and
 * `company` from the freshly-built jobs table in the same posted_at
 * DESC order the slim-index uses, so row IDs in postings line up with
 * row indices in the slim index dataset (after concatenation).
 */
export async function emitSearchIndex(
  db: Database,
  opts: EmitSearchIndexOptions,
): Promise<SearchIndexBuildResult> {
  const subdir = opts.subdir ?? "search";

  const stmt = db.prepare<{ title: string; company: string }, []>(
    "SELECT title, company FROM jobs ORDER BY posted_at DESC NULLS LAST, first_seen_at DESC",
  );
  const rows = stmt.all();

  // stem → sorted unique row indices.
  const postings = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const tokens = new Set<string>();
    for (const t of tokenise(r.title)) {
      if (STOP_WORDS.has(t)) continue;
      tokens.add(stem(t));
    }
    for (const t of tokenise(r.company)) {
      if (STOP_WORDS.has(t)) continue;
      tokens.add(stem(t));
    }
    for (const stemmed of tokens) {
      let list = postings.get(stemmed);
      if (!list) {
        list = [];
        postings.set(stemmed, list);
      }
      list.push(i);
    }
  }

  // Delta-encode + base-36 each posting list. Unique-row guarantee
  // above means deltas are strictly positive after the first entry.
  const stems: Record<string, string> = {};
  let totalPostings = 0;
  for (const [stemKey, list] of postings) {
    totalPostings += list.length;
    const encoded: string[] = [];
    let prev = 0;
    for (const idx of list) {
      encoded.push((idx - prev).toString(36));
      prev = idx;
    }
    stems[stemKey] = encoded.join(",");
  }

  const json = JSON.stringify({
    v: SEARCH_INDEX_SCHEMA_VERSION,
    n: rows.length,
    stems,
  });

  const fs = await import("node:fs/promises");
  await fs.mkdir(join(opts.outputDir, subdir), { recursive: true });
  const fileName = "title-tokens.json.gz";
  const filePath = join(opts.outputDir, subdir, fileName);
  const gz = gzipSync(json, { level: 9 });
  await writeFile(filePath, gz);

  return {
    fields: {
      search_index_schema_version: SEARCH_INDEX_SCHEMA_VERSION,
      search_index_filename: `${subdir}/${fileName}`,
      search_index_bytes_gz: gz.length,
      search_index_bytes_raw: Buffer.byteLength(json, "utf-8"),
      search_index_total_rows: rows.length,
      search_index_unique_stems: postings.size,
      search_index_total_postings: totalPostings,
    },
    outputPath: filePath,
  };
}
