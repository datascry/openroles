<script lang="ts">
import { ATS_IDS, LEVELS, WORKPLACE_TYPES } from "@openroles/shared/constants";
import { onMount } from "svelte";
import { sanitizeChipLabel } from "../lib/chip-label.ts";
import { computeSlimOptionCounts } from "../lib/filter-option-counts.ts";
import {
  DEFAULT_FILTER_STATE,
  decodeFilterState,
  encodeFilterState,
  type FilterState,
  type SinceWindow,
  type SortOption,
} from "../lib/filter-state.ts";
import { fetchManifest, type ManifestRuntime } from "../lib/manifest-runtime.ts";
import { pagesToShow } from "../lib/pager.ts";
import { withRetry } from "../lib/retry.ts";
import {
  type FilterPredicate,
  filterRows,
  type SlimRow,
  type SortKey,
  sortRows,
} from "../lib/slim-index.ts";
import { loadSlimIndex, type SlimIndex } from "../lib/slim-index-loader.ts";
import {
  loadApplied,
  loadIgnored,
  loadSaved,
  loadSavedSearches,
  markApplied,
  removeSavedSearch,
  type SavedSearchMode,
  saveSavedSearch,
  toggleIgnored,
  toggleSaved,
} from "../lib/storage.ts";
import FilterSheet from "./filter/FilterSheet.svelte";
import FilterSidebar from "./filter/FilterSidebar.svelte";
import SearchBar from "./SearchBar.svelte";

interface Props {
  basePath?: string;
}

const { basePath = "" }: Props = $props();

const NON_NULL_LEVELS = LEVELS.filter((l): l is NonNullable<(typeof LEVELS)[number]> => l !== null);

const SINCE_OPTIONS: ReadonlyArray<{ value: SinceWindow; label: string }> = [
  { value: "all", label: "Any time" },
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

const SINCE_LABEL: Record<SinceWindow, string> = {
  all: "ANY TIME",
  "24h": "LAST 24H",
  "7d": "LAST 7 DAYS",
  "30d": "LAST 30 DAYS",
  "90d": "LAST 90 DAYS",
};

// Sort UI removed entirely. Default order is `posted_at:desc` (newest
// first). SortOption stays for URL-back-compat (parses ?sort= for old
// links) and SORT_KEY_MAP below maps it to the runFilter sort step.

const PAGE_SIZE = 50;
// Q_DEBOUNCE: how long the search input waits before pushing into
// state. At 100 ms each keystroke fired a fresh filter pass over the
// 750k-row slim-index — on a mobile CPU a single pass costs 200-500 ms,
// so consecutive keystrokes piled up unfinished work and read as
// "search is laggy". 250 ms aligns with typical typing rhythm (most
// users pause >250 ms between intentional words) so a typed word
// triggers exactly one filter pass at the end, not one per character.
// QUERY_DEBOUNCE keeps a tiny coalesce window for chained state writes
// (page + filter changing in the same tick).
const Q_DEBOUNCE_MS = 250;
const QUERY_DEBOUNCE_MS = 50;

// Phase 14: rows come from the slim-index in memory. The shape matches
// what scraper/src/db/slim-index.ts emits — see SlimRow there.
// `id` aliases short_id (16-char hex) for the localStorage save/applied
// /ignored APIs that previously used the full 64-char id; they accept
// the 16-char form too because the localStorage validators only check
// hex shape, not length.
type JobRow = SlimRow;

type DbStatus = "loading" | "loading-progressive" | "ready" | "error";

const SHORT_ID_RE = /^[0-9a-f]{16}$/;

type FilterCategory = "ats" | "level" | "wt" | "since" | "min_comp";

let state: FilterState = $state(
  typeof window === "undefined"
    ? DEFAULT_FILTER_STATE
    : decodeFilterState(window.location.search.replace(/^\?/, "")),
);

let qInput = $state(state.q);
let qDebounceHandle: ReturnType<typeof setTimeout> | undefined;

// $state.raw — NOT $state — because the loader mutates slimIndex.rows
// in place via appendUnique as chunks land. Svelte 5's $state deep-
// proxies arrays and caches a length signal at assignment time; raw-
// array pushes from the loader bypass the proxy so the signal never
// updates and runFilter ends up scanning only chunk 0's 20k rows even
// after all 38 chunks (747k rows) have merged. $state.raw tracks the
// assignment (so the $effect that schedules the first runFilter still
// fires when slimIndex flips null → object) but leaves inner refs
// alone — slimIndex.rows.length always reflects the live array.
let slimIndex: SlimIndex | null = $state.raw(null);
let manifest: ManifestRuntime | null = $state(null);
let dbStatus: DbStatus = $state("loading");
let dbError: string | null = $state(null);
let queryError: string | null = $state(null);
let rows: JobRow[] = $state([]);
let totalCount: number = $state(0);
let queryToken: number = 0;
// Set true when runFilter is about to start a heavy sort/filter pass so
// the status line can show "SORTING…" before the synchronous work blocks
// the main thread. Critical at 750k rows: without it, the click → sort
// path was a 2-10 second perceptual freeze with zero feedback.
let isQueryRunning: boolean = $state(false);
// Two SEPARATE debounce handles, deliberately not sharing one. The
// chunk-merge debounce ("filter again after the rows array grows") and
// the user-input debounce ("filter again after the user finishes
// typing") used to share a handle, which meant a chunk landing during
// typing would clear the user's pending runFilter and reschedule it
// for 750ms later. The user's typed query never actually executed
// against the live dataset until chunks fully settled — a multi-second
// stall that produced confusing partial counts mid-load. Two handles
// fixes that: each runFilter source manages its own timer, the latest
// queryToken arbitrates if both fire close together.
let queryDebounceHandle: ReturnType<typeof setTimeout> | undefined;
let chunkDebounceHandle: ReturnType<typeof setTimeout> | undefined;
// Progressive load progress for the "loading 4 of 16 chunks" indicator.
let chunksLoaded: number = $state(0);
let chunksTotal: number = $state(0);
// Reactivity hook: optionCounts and any other $derived that reads
// slimIndex.rows by reference needs a value-based dependency to fire
// when rows grows in place. (slimIndex is $state.raw because the loader
// mutates rows via appendUnique — Svelte deep-proxy would break that.)
// We bump this counter every time a chunk merges in; $derived blocks
// that read it re-run on every chunk.
let chunkMergeTick: number = $state(0);

let savedIds: ReadonlyArray<string> = $state([]);
let appliedIds: ReadonlyArray<string> = $state([]);
let ignoredIds: ReadonlyArray<string> = $state([]);
let hideIgnored = $state(true);

// Single open category at a time. Click outside or a different "+ Add"
// button closes any open popover. Esc also closes.
let openCategory: FilterCategory | null = $state(null);

let filterBarEl: HTMLElement | null = $state(null);

// Mobile sheet open / saved-searches state for the SearchBar.
// (specs/uplift-v2-handoff.md §1 + §2.7.b)
let sheetOpen = $state(false);
let savedSearches: ReadonlyArray<{
  id: string;
  label: string;
  q: string;
  mode: SavedSearchMode;
}> = $state([]);
// Bumped each time the user applies a saved search so the SearchBar's
// mode-restore $effect refires even if the same q is applied twice.
let savedSearchApplyToken = $state(0);
let savedSearchApplyMode: SavedSearchMode | undefined = $state(undefined);

function refreshSavedSearches(): void {
  if (typeof window === "undefined") return;
  savedSearches = loadSavedSearches(window.localStorage).entries.map((e) => ({
    id: e.id,
    label: e.label,
    q: e.q,
    mode: e.mode,
  }));
}

function refreshUserLists(): void {
  if (typeof window === "undefined") return;
  savedIds = loadSaved(window.localStorage).ids;
  appliedIds = loadApplied(window.localStorage).entries.map((e) => e.id);
  ignoredIds = loadIgnored(window.localStorage).ids;
}

function isSaved(id: string): boolean {
  return savedIds.includes(id);
}

function isApplied(id: string): boolean {
  return appliedIds.includes(id);
}

function isIgnored(id: string): boolean {
  return ignoredIds.includes(id);
}

function onToggleSaved(id: string): void {
  if (typeof window === "undefined") return;
  toggleSaved(window.localStorage, id);
  refreshUserLists();
}

function onToggleIgnored(id: string): void {
  if (typeof window === "undefined") return;
  toggleIgnored(window.localStorage, id);
  refreshUserLists();
}

function onMarkApplied(id: string): void {
  if (typeof window === "undefined") return;
  markApplied(window.localStorage, id, new Date().toISOString());
  refreshUserLists();
}

// `Hide ignored` is the post-query filter that strips ignored rows from
// view by default. When the user has explicitly opted into the ignored
// sub-view (`showOnly === "ignored"`), short-circuit the post-filter so
// the panel actually has rows to show. Same precedence rule as the spec.
const visibleRows = $derived(
  state.showOnly === "ignored"
    ? rows
    : hideIgnored
      ? rows.filter((r) => !isIgnored(r.short_id))
      : rows,
);

function syncUrl(next: FilterState) {
  if (typeof window === "undefined") return;
  const qs = encodeFilterState(next);
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  window.history.replaceState(null, "", url);
}

function updateState(patch: Partial<FilterState>) {
  state = { ...state, ...patch, page: patch.page ?? 1 };
  syncUrl(state);
}

function onQInput(value: string) {
  qInput = value;
  if (qDebounceHandle) clearTimeout(qDebounceHandle);
  qDebounceHandle = setTimeout(() => updateState({ q: value }), Q_DEBOUNCE_MS);
}

function clearQ() {
  qInput = "";
  if (qDebounceHandle) clearTimeout(qDebounceHandle);
  updateState({ q: "" });
}

function toggleAts(id: (typeof ATS_IDS)[number]) {
  const next = state.ats.includes(id) ? state.ats.filter((x) => x !== id) : [...state.ats, id];
  updateState({ ats: next });
}

function removeAts(id: (typeof ATS_IDS)[number]) {
  updateState({ ats: state.ats.filter((x) => x !== id) });
}

function toggleLevel(id: NonNullable<(typeof LEVELS)[number]>) {
  const next = state.level.includes(id)
    ? state.level.filter((x) => x !== id)
    : [...state.level, id];
  updateState({ level: next });
}

function removeLevel(id: NonNullable<(typeof LEVELS)[number]>) {
  updateState({ level: state.level.filter((x) => x !== id) });
}

function toggleWt(id: (typeof WORKPLACE_TYPES)[number]) {
  const next = state.wt.includes(id) ? state.wt.filter((x) => x !== id) : [...state.wt, id];
  updateState({ wt: next });
}

function removeWt(id: (typeof WORKPLACE_TYPES)[number]) {
  updateState({ wt: state.wt.filter((x) => x !== id) });
}

function setSort(value: SortOption) {
  updateState({ sort: value });
}

function setSince(value: SinceWindow) {
  updateState({ since: value });
}

function setMinComp(raw: string) {
  if (raw.trim() === "") {
    updateState({ minComp: undefined });
    return;
  }
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 0) updateState({ minComp: n });
}

function gotoPage(page: number) {
  if (page < 1) return;
  state = { ...state, page };
  syncUrl(state);
  // Scroll the role list back to the top of viewport. Without this, the
  // browser's scroll-anchoring keeps the clicked pager button in view —
  // on mobile that lands the user in the middle of page N+1's content
  // instead of its first row, which reads as "next page is broken".
  // requestAnimationFrame waits for the new rows to render so the
  // results-status banner is the right scroll target.
  if (typeof requestAnimationFrame !== "undefined") {
    requestAnimationFrame(() => {
      const target = document.querySelector(".results-status");
      if (target && "scrollIntoView" in target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }
}

function resetAll() {
  state = { ...DEFAULT_FILTER_STATE };
  qInput = "";
  syncUrl(state);
}

function togglePopover(cat: FilterCategory) {
  openCategory = openCategory === cat ? null : cat;
}

function closePopover() {
  openCategory = null;
}

const totalPages = $derived(Math.max(1, Math.ceil(totalCount / PAGE_SIZE)));
const hasPrev = $derived(state.page > 1);
const hasNext = $derived(state.page < totalPages);

// Compare `since` against the runtime default rather than "all" — the
// default narrow window ships everywhere now (specs/uplift-v2-handoff.md
// §2.4) so counting it as "active" would surface a stale "1 active"
// indicator on every fresh visit.
const activeFilterCount = $derived(
  (state.q ? 1 : 0) +
    state.ats.length +
    state.level.length +
    state.wt.length +
    (state.since !== DEFAULT_FILTER_STATE.since ? 1 : 0) +
    (state.hideRecruiter ? 1 : 0) +
    (state.hideStale ? 1 : 0) +
    (state.showOnly !== undefined ? 1 : 0) +
    (state.minComp !== undefined ? 1 : 0),
);

const pagerPages = $derived(totalPages > 1 ? pagesToShow(state.page, totalPages) : []);

const sanitizedQ = $derived(sanitizeChipLabel(state.q));

/**
 * Read the SSR pre-paint rows out of the inline `<script
 * type="application/json" id="first-paint-data">` element so we can
 * use them as initial state — no extra fetch for content the page
 * already shipped.
 */
function readSeedRows(): SlimRow[] {
  if (typeof document === "undefined") return [];
  const el = document.getElementById("first-paint-data");
  if (!el) return [];
  try {
    const parsed = JSON.parse(el.textContent ?? "[]") as Array<Record<string, unknown>>;
    // The SSR shape (FirstPaintRow) uses snake_case field names that
    // already match SlimRow except for is_recruiter_post / is_stale
    // (booleans both sides). Pass through the validated subset.
    return parsed.map((p) => ({
      short_id: String(p["short_id"] ?? ""),
      ats: String(p["ats"] ?? ""),
      tenant_slug: String(p["tenant_slug"] ?? ""),
      title: String(p["title"] ?? ""),
      company: String(p["company"] ?? ""),
      level: typeof p["level"] === "string" ? p["level"] : null,
      workplace_type: typeof p["workplace_type"] === "string" ? p["workplace_type"] : null,
      is_recruiter_post: p["is_recruiter_post"] === true,
      is_stale: p["is_stale"] === true,
      location_text: typeof p["location_text"] === "string" ? p["location_text"] : null,
      location_country: typeof p["location_country"] === "string" ? p["location_country"] : null,
      posted_at: typeof p["posted_at"] === "string" ? p["posted_at"] : null,
      first_seen_at: String(p["first_seen_at"] ?? ""),
      last_seen_at: String(p["last_seen_at"] ?? p["first_seen_at"] ?? ""),
      compensation_min: typeof p["compensation_min"] === "number" ? p["compensation_min"] : null,
      compensation_max: null,
      compensation_currency: null,
      url: typeof p["url"] === "string" ? p["url"] : "",
    }));
  } catch {
    return [];
  }
}

onMount(async () => {
  refreshUserLists();
  refreshSavedSearches();
  // Seed with the SSR pre-paint rows so the user sees something
  // sensible even before the slim index lands.
  const seed = readSeedRows();
  if (seed.length > 0) {
    rows = seed;
    totalCount = seed.length;
  }
  // Remove the SSR pre-paint aside as soon as the Svelte island is
  // active and ready to render its own rows. Without this, both the
  // SSR markup AND the FilterTable's hydrated rows render — doubles
  // the homepage list visually. The :has() CSS selector approach we
  // tried first turned out unreliable because the aside itself
  // contains <ul class="results">, so the trigger matches its own
  // content. Imperative removal is foolproof.
  if (typeof document !== "undefined") {
    document.getElementById("first-paint-rows")?.remove();
  }
  try {
    // Manifest fetch wrapped in withRetry so a single packet loss on a
    // flaky mobile carrier doesn't surface the harsh "COULD NOT LOAD"
    // error. Three attempts, 200/800/2000 ms backoff, then surrender.
    manifest = await withRetry(() => fetchManifest(basePath));
    if (manifest.slim_index_chunks.length === 0) {
      throw new Error(
        "FilterTable: this build did not emit a slim index; cannot run client-side filters",
      );
    }
    chunksTotal = manifest.slim_index_chunks.length;
    dbStatus = "loading-progressive";
    // Throttle the per-chunk re-render rather than debounce. Each filter
    // pass is an O(n) walk over the accumulated rows array — on a slow
    // CPU n=750k is a 100-200ms task — but a pure debounce loses every
    // intermediate refresh: the worker streams chunks faster than the
    // debounce interval, so the timeout was constantly cleared and
    // runFilter never fired until fullyLoaded (~20s of stale "20,000
    // ROLES" + chunk-0 chip counts). Throttle to at-most-once per
    // CHUNK_REFILTER_THROTTLE_MS and always trail with one final fire.
    //
    // Each chunk merge also bumps chunkMergeTick so the optionCounts
    // $derived (which reads slimIndex.rows by reference) re-runs.
    // Without that bump it never re-evaluates after the initial assign
    // because Svelte's deep-proxy is bypassed for $state.raw.
    const CHUNK_REFILTER_THROTTLE_MS = 1500;
    let lastRefilterAt = 0;
    slimIndex = await loadSlimIndex({
      basePath,
      manifest,
      seed,
      onChunk: (_chunk, _cumulative, _total) => {
        chunksLoaded += 1;
        chunkMergeTick += 1;
        const now = Date.now();
        const elapsed = now - lastRefilterAt;
        if (chunkDebounceHandle) clearTimeout(chunkDebounceHandle);
        if (elapsed >= CHUNK_REFILTER_THROTTLE_MS) {
          lastRefilterAt = now;
          runFilter(state);
        } else {
          chunkDebounceHandle = setTimeout(() => {
            lastRefilterAt = Date.now();
            runFilter(state);
          }, CHUNK_REFILTER_THROTTLE_MS - elapsed);
        }
      },
    });
    dbStatus = "ready";
    // Final settled-state refresh once every chunk has merged.
    chunkMergeTick += 1;
    runFilter(state);
  } catch (err) {
    dbStatus = "error";
    dbError = err instanceof Error ? err.message : String(err);
  }
});

const SINCE_HOURS: Record<SinceWindow, number | null> = {
  all: null,
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
  "90d": 24 * 90,
};

function buildPredicate(s: FilterState): FilterPredicate {
  const predicate: FilterPredicate = {};
  // q: case-insensitive substring match against title, company,
  // location_text, workplace_type, and level. We deliberately do NOT
  // tokenise/stem here — job titles are short canonical phrases, and
  // substring is what users intuit. Stem search collapsed `java`/
  // `javascript` into different stems and dropped queries with
  // non-word chars (C++, .NET, AI/ML) entirely; the bandwidth tax for
  // the inverted index also wasn't worth the marginal recall lift.
  const trimmed = s.q.trim();
  if (trimmed.length > 0) predicate.q = trimmed;
  if (s.ats.length > 0) predicate.ats = new Set(s.ats);
  if (s.level.length > 0) predicate.level = new Set(s.level);
  if (s.wt.length > 0) predicate.workplace_type = new Set(s.wt);
  if (s.country !== undefined) predicate.country = s.country;
  if (s.hideRecruiter) predicate.hideRecruiter = true;
  if (s.hideStale) predicate.hideStale = true;
  if (s.minComp !== undefined) predicate.minComp = s.minComp;
  const sinceHours = SINCE_HOURS[s.since];
  if (sinceHours !== null) predicate.sinceMs = Date.now() - sinceHours * 3_600_000;
  // showOnly narrows to the matching localStorage list (intentionally
  // empty → zero rows; specs/filter-ui.md v1.2.0). The list is set as
  // an idAllowlist of the user's saved/applied/ignored short_ids so
  // filterRows can short-circuit non-matches before running text/enum
  // checks.
  const saveSetSource =
    s.showOnly === "saved"
      ? savedIds
      : s.showOnly === "applied"
        ? appliedIds
        : s.showOnly === "ignored"
          ? ignoredIds
          : null;
  if (saveSetSource !== null) {
    predicate.idAllowlist = new Set(saveSetSource);
  }
  return predicate;
}

const SORT_KEY_MAP: Record<SortOption, SortKey> = {
  "posted_at:desc": "posted_at:desc",
  "posted_at:asc": "posted_at:asc",
  "first_seen:desc": "first_seen:desc",
  "first_seen:asc": "first_seen:asc",
  "company:asc": "company:asc",
  "company:desc": "company:desc",
  "level:asc": "level:asc",
  "level:desc": "level:desc",
};

async function runFilter(currentState: FilterState): Promise<void> {
  const token = ++queryToken;
  if (slimIndex === null) return;
  // Flip the busy flag and yield to the event loop so the status line
  // can paint "WORKING…" before the synchronous filter+sort blocks the
  // main thread. At 750k rows the sort alone costs 2–10 s on a slow
  // CPU; without the yield, the click looks like a browser freeze.
  isQueryRunning = true;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  if (token !== queryToken) return; // a newer call superseded us
  try {
    const predicate = buildPredicate(currentState);
    // Materialise then sort only the matched rows — sorting all 750k
    // every keystroke is wasteful. `filterRows` walks the full set
    // once and returns matches in input order; we then sort those.
    const all = filterRows(slimIndex.rows, predicate, 0, Number.POSITIVE_INFINITY);
    if (token !== queryToken) return;
    const sortKey = SORT_KEY_MAP[currentState.sort];
    sortRows(all.matches, sortKey);
    const offset = (currentState.page - 1) * PAGE_SIZE;
    rows = all.matches.slice(offset, offset + PAGE_SIZE);
    totalCount = all.total;
    queryError = null;
  } finally {
    if (token === queryToken) isQueryRunning = false;
  }
}

$effect(() => {
  const snapshot = state;
  if (slimIndex === null) return;
  if (queryDebounceHandle) clearTimeout(queryDebounceHandle);
  queryDebounceHandle = setTimeout(() => runFilter(snapshot), QUERY_DEBOUNCE_MS);
});

// Per-chip option counts derived from the slim index. Re-runs every
// time a chunk merges (chunkMergeTick increments) so chip counts grow
// alongside the corpus during progressive load — without that read,
// $derived would lock onto the chunk-0 counts forever because slimIndex
// is $state.raw and inner-array mutation is invisible to the runtime.
const optionCounts = $derived.by(() => {
  // Read chunkMergeTick so $derived.by tracks it as a dependency. Required
  // because slimIndex is $state.raw — its inner-array mutations don't
  // notify the runtime, so we tick a counter on every chunk merge to
  // force this derived to refire and re-count option facets.
  void chunkMergeTick;
  if (slimIndex === null) return undefined;
  return computeSlimOptionCounts(slimIndex.rows, state, buildPredicate);
});

// SearchBar / FilterSidebar / FilterSheet wiring. The new components
// emit `Partial<FilterState>` patches that map directly to updateState.
function onPatch(patch: Partial<FilterState>) {
  updateState(patch);
}

function onSearchChange(next: string) {
  updateState({ q: next });
}

function onSaveSearch(label: string, q: string, mode: SavedSearchMode) {
  if (typeof window === "undefined") return;
  saveSavedSearch(window.localStorage, label, q, mode);
  refreshSavedSearches();
}

function onApplySavedSearch(id: string) {
  const entry = savedSearches.find((s) => s.id === id);
  if (!entry) return;
  savedSearchApplyMode = entry.mode;
  savedSearchApplyToken += 1;
  updateState({ q: entry.q });
}

// Used by the saved-searches list (delete affordance lives on the search
// bar's Recent row in a future revision; the storage helper is here so
// it survives a typecheck even if the UI is not yet wired up).
function onRemoveSavedSearch(id: string) {
  if (typeof window === "undefined") return;
  removeSavedSearch(window.localStorage, id);
  refreshSavedSearches();
}

// Click-outside + Esc close the open popover.
$effect(() => {
  if (openCategory === null) return;
  if (typeof document === "undefined") return;

  function onClickOutside(e: MouseEvent) {
    const target = e.target as Node | null;
    if (target && filterBarEl && !filterBarEl.contains(target)) {
      closePopover();
    }
  }
  function onEsc(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      closePopover();
    }
  }
  document.addEventListener("mousedown", onClickOutside);
  document.addEventListener("keydown", onEsc);
  return () => {
    document.removeEventListener("mousedown", onClickOutside);
    document.removeEventListener("keydown", onEsc);
  };
});

function formatAge(
  iso: string | null | undefined,
  now: number = Date.now(),
): {
  label: string;
  fresh: boolean;
} {
  if (!iso) return { label: "—", fresh: false };
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return { label: "—", fresh: false };
  const diff = Math.max(0, now - t);
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return { label: `${hours}h`, fresh: true };
  const days = Math.floor(hours / 24);
  if (days < 30) return { label: `${days}d`, fresh: false };
  return { label: new Date(iso).toISOString().slice(0, 10), fresh: false };
}

/**
 * Days since the role was last scraped successfully — used to render the
 * `STALE · ND` badge per specs/role-lifecycle.md. Floors at 1 day so a
 * row marked stale on the same calendar day as build still reads "1d"
 * rather than "0d".
 */
function staleAgeDays(lastSeenAt: string | undefined, now: number = Date.now()): number {
  if (!lastSeenAt) return 1;
  const t = new Date(lastSeenAt).getTime();
  if (Number.isNaN(t)) return 1;
  return Math.max(1, Math.floor((now - t) / 86_400_000));
}

function clickSort(col: "posted_at" | "company" | "level" | "first_seen") {
  const cur = state.sort;
  if (col === "posted_at") {
    setSort(cur === "posted_at:desc" ? "posted_at:asc" : "posted_at:desc");
  } else if (col === "company") {
    setSort(cur === "company:asc" ? "company:desc" : "company:asc");
  } else if (col === "level") {
    setSort(cur === "level:asc" ? "level:desc" : "level:asc");
  } else if (col === "first_seen") {
    setSort(cur === "first_seen:desc" ? "first_seen:asc" : "first_seen:desc");
  }
}

function ariaSort(
  col: "posted_at" | "company" | "level" | "first_seen",
): "ascending" | "descending" | "none" {
  const s = state.sort;
  if (col === "posted_at") {
    if (s === "posted_at:asc") return "ascending";
    if (s === "posted_at:desc") return "descending";
  }
  if (col === "company") {
    if (s === "company:asc") return "ascending";
    if (s === "company:desc") return "descending";
  }
  if (col === "level") {
    if (s === "level:asc") return "ascending";
    if (s === "level:desc") return "descending";
  }
  if (col === "first_seen") {
    if (s === "first_seen:asc") return "ascending";
    if (s === "first_seen:desc") return "descending";
  }
  return "none";
}
</script>

<!-- Dual-mode search bar (specs/uplift-v2-handoff.md §1). Free-text /
     structured tabs round-trip through FilterState.q via composeQuery /
     parseQuery; the structured form gives a discoverable surface for
     the title:/company:/location: scoping the legacy single input
     hinted at via placeholder. -->
<SearchBar
  q={state.q}
  totalRoles={totalCount}
  onChange={onSearchChange}
  savedSearches={savedSearches}
  onSaveSearch={onSaveSearch}
  onApplySavedSearch={onApplySavedSearch}
  applyToken={savedSearchApplyToken}
  applyMode={savedSearchApplyMode}
/>

<!-- Filter bar: applied filters + add-filter buttons + sort + reset.
     The strip wraps; on desktop it stays on a single row when possible. -->
<div class="filter-bar" bind:this={filterBarEl}>
  <!-- Applied filters render first so the user sees what's already on. -->
  {#if state.q && sanitizedQ}
    <button type="button" class="active-chip accent" onclick={clearQ}>
      <span aria-hidden="true">"{sanitizedQ}"</span>
      <span class="visually-hidden">remove search filter</span>
      <span class="x" aria-hidden="true">×</span>
    </button>
  {/if}
  {#each state.ats as id (`ats-${id}`)}
    <button type="button" class="active-chip" onclick={() => removeAts(id)}>
      <span>{id}</span>
      <span class="visually-hidden">remove ATS filter {id}</span>
      <span class="x" aria-hidden="true">×</span>
    </button>
  {/each}
  {#each state.level as id (`level-${id}`)}
    <button type="button" class="active-chip" onclick={() => removeLevel(id)}>
      <span>{id}</span>
      <span class="visually-hidden">remove level filter {id}</span>
      <span class="x" aria-hidden="true">×</span>
    </button>
  {/each}
  {#each state.wt as id (`wt-${id}`)}
    <button type="button" class="active-chip" onclick={() => removeWt(id)}>
      <span>{id}</span>
      <span class="visually-hidden">remove workplace filter {id}</span>
      <span class="x" aria-hidden="true">×</span>
    </button>
  {/each}
  {#if state.since !== "all"}
    <button type="button" class="active-chip" onclick={() => setSince("all")}>
      <span>{SINCE_LABEL[state.since]}</span>
      <span class="visually-hidden">remove posted-within filter</span>
      <span class="x" aria-hidden="true">×</span>
    </button>
  {/if}
  {#if state.hideRecruiter}
    <button type="button" class="active-chip" onclick={() => updateState({ hideRecruiter: false })}>
      <span>NO RECRUITERS</span>
      <span class="visually-hidden">remove recruiter filter</span>
      <span class="x" aria-hidden="true">×</span>
    </button>
  {/if}
  {#if state.hideStale}
    <button type="button" class="active-chip" onclick={() => updateState({ hideStale: false })}>
      <span>VERIFIED ONLY</span>
      <span class="visually-hidden">remove verified-only filter</span>
      <span class="x" aria-hidden="true">×</span>
    </button>
  {/if}
  {#if state.showOnly !== undefined}
    <button
      type="button"
      class="active-chip accent"
      onclick={() => updateState({ showOnly: undefined })}
    >
      <span>SHOWING {state.showOnly.toUpperCase()}</span>
      <span class="visually-hidden">remove sub-view filter</span>
      <span class="x" aria-hidden="true">×</span>
    </button>
  {/if}
  {#if state.minComp !== undefined}
    <button type="button" class="active-chip" onclick={() => updateState({ minComp: undefined })}>
      <span>MIN ${Math.floor(state.minComp / 1000)}K</span>
      <span class="visually-hidden">remove min comp filter</span>
      <span class="x" aria-hidden="true">×</span>
    </button>
  {/if}

  <!-- Single mobile entry point into the FilterSheet. The desktop sidebar
       (rendered below in `.layout-grid`) supersedes the per-category
       add-filter popovers; this button only renders <800px. -->
  <button
    type="button"
    class="filters-button"
    aria-haspopup="dialog"
    aria-expanded={sheetOpen}
    aria-controls="filter-sheet"
    onclick={() => { sheetOpen = true; }}
  >Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}</button>

  <!-- Sort UI removed. The default order is `posted_at:desc` (newest
       first), which is what 95% of job seekers want; the other options
       were either developer concepts (first_seen) or duplicated by the
       Level filter chips. URL-back-compat preserved: a saved-search
       link with `?sort=…` still parses but the param is honored only
       for posted_at variants — anything else falls back to the
       default. SortKey + SORT_KEY_MAP + sortRows kept for the runFilter
       internal sort step. -->

  {#if activeFilterCount > 0}
    <button type="button" class="reset" onclick={resetAll}>Reset all</button>
  {/if}
</div>

<!-- Two-column layout: persistent sidebar ≥ var(--bp-sidebar) (800px),
     collapses to a sheet on narrower viewports (specs/uplift-v2-handoff.md
     §2). The sidebar mirrors the sheet's groups so opening / closing the
     sheet is purely a mobile affordance. -->
<div class="layout-grid">
  <aside class="sidebar-col">
    <FilterSidebar
      filters={state}
      onPatch={onPatch}
      savedCount={savedIds.length}
      appliedCount={appliedIds.length}
      ignoredCount={ignoredIds.length}
      optionCounts={optionCounts}
    />
  </aside>
  <div class="main-col">

<p
  class="results-status"
  aria-live="polite"
  aria-busy={dbStatus === "loading" || isQueryRunning}
>
  {#if dbStatus === "ready"}
    {#if isQueryRunning}
      <!-- Busy indicator surfaces during the synchronous filter pass
           on the 750k-row dataset. Without it the click looks like a
           browser freeze. The blinking dot below adds motion so the
           label isn't a static stretch of text during a long pass. -->
      <span class="busy-dot" aria-hidden="true"></span>
      LOADING ROLES…
    {:else}
      {#if state.showOnly !== undefined}<span class="status-scope">{state.showOnly.toUpperCase()} ·</span> {/if}
      <b>{totalCount.toLocaleString()}</b> {totalCount === 1 ? "ROLE" : "ROLES"} ·
      PAGE {state.page}
    {/if}
  {:else if dbStatus === "loading"}
    <span class="busy-dot" aria-hidden="true"></span>
    LOADING ROLES…
  {:else}
    COULD NOT LOAD THE JOB DATABASE.
  {/if}
</p>

<noscript>
  <p>This filter UI requires JavaScript. The current build of openroles ships data via
    <code>sql.js-httpvfs</code>; results are rendered after the database loads.</p>
</noscript>

{#if dbStatus === "loading"}
  <p class="data-pending">Loading data…</p>
{:else if dbStatus === "error"}
  <p class="data-error" role="alert">
    {dbError ?? "Unknown error loading the database."}
  </p>
{:else}
  {#if queryError}
    <p class="data-error" role="status">{queryError}</p>
  {/if}
  {#if rows.length === 0}
    <p class="data-empty">No roles match the current filters.</p>
  {:else}
    <!--
      The header row uses CSS grid + buttons to drive sort. The previous
      version put aria-sort directly on the buttons, which axe (correctly)
      rejected: aria-sort is only valid on role=columnheader/rowheader/
      gridcell, never on a plain button. Encoding the same information
      via a dynamic aria-label keeps the announcement for screen readers
      ("Sort by company, currently ascending") without the schema
      violation. Visible arrow stays the same.
    -->
    <!-- role="row" was removed: axe (correctly) flagged it as
         aria-required-parent / aria-required-children violations because
         the surrounding markup is a div-grid, not a real table or
         role=grid. The header still presents as a labelled set of
         clickable column headers via aria-label on each button; that's
         enough semantic information for assistive tech without
         introducing aria-row plumbing the rest of the structure can't
         support. -->
    <div class="results-head">
      <button
        type="button"
        class="col-head col-role"
        onclick={() => clickSort("company")}
        aria-label={`Sort by company${ariaSort("company") === "none" ? "" : `, currently ${ariaSort("company")}`}`}
      >
        ROLE
        {#if ariaSort("company") === "ascending"}
          <span class="arr" aria-hidden="true">↑</span>
        {:else if ariaSort("company") === "descending"}
          <span class="arr" aria-hidden="true">↓</span>
        {/if}
      </button>
      <span class="col-head col-location">LOCATION</span>
      <button
        type="button"
        class="col-head col-level"
        onclick={() => clickSort("level")}
        aria-label={`Sort by level${ariaSort("level") === "none" ? "" : `, currently ${ariaSort("level")}`}`}
      >
        LEVEL
        {#if ariaSort("level") === "ascending"}
          <span class="arr" aria-hidden="true">↑</span>
        {:else if ariaSort("level") === "descending"}
          <span class="arr" aria-hidden="true">↓</span>
        {/if}
      </button>
      <button
        type="button"
        class="col-head col-posted"
        onclick={() => clickSort("posted_at")}
        aria-label={`Sort by posted date${ariaSort("posted_at") === "none" ? "" : `, currently ${ariaSort("posted_at")}`}`}
      >
        POSTED
        {#if ariaSort("posted_at") === "ascending"}
          <span class="arr" aria-hidden="true">↑</span>
        {:else if ariaSort("posted_at") === "descending"}
          <span class="arr" aria-hidden="true">↓</span>
        {/if}
      </button>
      <span class="col-head col-actions" aria-hidden="true"></span>
    </div>

    <ul class="results" role="list" data-testid="job-results">
      {#each visibleRows as row (row.short_id)}
        {@const age = formatAge(row.posted_at)}
        {@const stale = row.is_stale}
        <li class="job" class:applied={isApplied(row.short_id)} class:is-stale={stale}>
          <div class="job-cell job-cell--role">
            <h3 class="company">
              <span class="company-name">{row.company}</span>
              {#if stale}
                <span
                  class="stale-badge"
                  title="The source ATS hasn't responded recently — the role may still be open."
                >STALE</span>
              {:else if age.fresh}
                <span class="new-badge" aria-label="new">NEW</span>
              {/if}
              {#if row.is_recruiter_post}
                <span class="recruiter-badge" aria-label="recruiter posting">RECRUITER</span>
              {/if}
              {#if isApplied(row.short_id)}
                <span class="applied-badge" aria-label="you have marked this as applied"
                  >APPLIED</span
                >
              {/if}
            </h3>
            <!-- ADR-0012: row title links directly to the source ATS apply
                 page in a new tab. There is no per-role detail page. -->
            <a
              href={row.url}
              target="_blank"
              rel="noopener noreferrer"
              class="job-title"
              onclick={() => onMarkApplied(row.short_id)}
            >
              {row.title}
            </a>
          </div>
          <div
            class="job-cell job-cell--location"
            class:is-empty={!row.location_text && !row.workplace_type}
          >
            {row.location_text ?? ""}
            {#if row.workplace_type}
              {#if row.location_text}<span class="rule" aria-hidden="true">·</span>{/if}
              <span class="wt">{row.workplace_type}</span>
            {/if}
          </div>
          <div class="job-cell job-cell--level" class:is-empty={!row.level}>
            {row.level ?? ""}
          </div>
          <div class="job-cell job-cell--posted">
            <span class="age" class:is-new={age.fresh}>{age.label}</span>
          </div>
          <div class="job-cell job-cell--actions">
            <div class="job-actions">
              <button
                type="button"
                class="job-action save"
                aria-pressed={isSaved(row.short_id)}
                aria-label={isSaved(row.short_id) ? "Remove from saved" : "Save this role"}
                title={isSaved(row.short_id) ? "Saved · click to remove" : "Save"}
                onclick={() => onToggleSaved(row.short_id)}
              >
                <!-- Glyph-only. The ☆ / ★ toggle is the entire button
                     content; aria-label + title surface the meaning to
                     keyboard / screen-reader / hover users. -->
                <span aria-hidden="true">{isSaved(row.short_id) ? "★" : "☆"}</span>
              </button>
              <a
                href={row.url}
                target="_blank"
                rel="noopener noreferrer"
                class="job-action apply"
                aria-label={`Apply for ${row.title} at ${row.company} on ${row.ats} (opens in a new tab)`}
                onclick={() => onMarkApplied(row.short_id)}
              >
                Apply →
              </a>
              <button
                type="button"
                class="job-action ignore"
                aria-pressed={isIgnored(row.short_id)}
                aria-label={isIgnored(row.short_id) ? "Restore this role" : "Hide this role"}
                title={isIgnored(row.short_id) ? "Hidden · click to restore" : "Hide"}
                onclick={() => onToggleIgnored(row.short_id)}
              >
                <!-- Glyph-only. × dismisses (default); ↺ restores when
                     already ignored. aria-label + title carry the
                     meaning for keyboard / screen-reader / hover users. -->
                <span aria-hidden="true">{isIgnored(row.short_id) ? "↺" : "×"}</span>
              </button>
            </div>
          </div>
        </li>
      {/each}
    </ul>

    {#if totalPages > 1}
      <nav class="pager" aria-label="Pagination" data-testid="pager">
        <button
          type="button"
          class="pager-edge"
          disabled={!hasPrev}
          onclick={() => gotoPage(state.page - 1)}
          aria-label="Previous page"
        >‹</button>

        <!-- Compact summary; replaced by the numbered list at ≥ 640 px. -->
        <span class="pager-summary">
          PAGE <b>{state.page.toLocaleString()}</b> OF {totalPages.toLocaleString()}
        </span>

        <ol class="pager-pages" role="list">
          {#each pagerPages as token, i (i)}
            {#if token === "ellipsis"}
              <li class="pager-ellipsis" aria-hidden="true">…</li>
            {:else}
              <li>
                <button
                  type="button"
                  class="pager-page"
                  class:is-current={token === state.page}
                  aria-current={token === state.page ? "page" : undefined}
                  onclick={() => gotoPage(token)}
                >{token}</button>
              </li>
            {/if}
          {/each}
        </ol>

        <button
          type="button"
          class="pager-edge"
          disabled={!hasNext}
          onclick={() => gotoPage(state.page + 1)}
          aria-label="Next page"
        >›</button>
      </nav>
    {/if}
  {/if}
{/if}

  </div><!-- /.main-col -->
</div><!-- /.layout-grid -->

<!-- FilterSheet stays mounted; opening is a CSS transition rather than a
     Svelte mount of seven groups + ~50 chips. Hidden visually + via inert
     while closed. -->
<FilterSheet
  filters={state}
  onPatch={onPatch}
  resultCount={totalCount}
  savedCount={savedIds.length}
  appliedCount={appliedIds.length}
  ignoredCount={ignoredIds.length}
  optionCounts={optionCounts}
  open={sheetOpen}
  onClose={() => { sheetOpen = false; }}
/>

<style>
  /* Brutalist Press — see specs/visual-theme.md.
     Tokens come from site/src/styles/tokens.css. */

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }

  /* ---------- Search row ---------- */
  .search-row {
    margin-block-end: var(--space-3);
  }
  .search-label { display: block; }

  .search-help {
    margin-block-start: var(--space-2);
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-size: var(--text-0);
    letter-spacing: var(--track-wide);
  }
  .search-help summary {
    color: var(--color-ink-2);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    cursor: pointer;
    list-style: none;
    user-select: none;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--tap);
    padding: 0 var(--space-2);
  }
  .search-help summary::before {
    content: "?";
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.4em;
    height: 1.4em;
    border: var(--rule-1) solid var(--color-ink-2);
    border-radius: 0;
    font-size: var(--text-1);
  }
  .search-help[open] summary { color: var(--color-ink); }
  .search-help ul {
    list-style: none;
    padding: var(--space-2) 0 0 var(--space-3);
    margin: 0;
    display: grid;
    gap: var(--space-1);
  }
  .search-help code {
    color: var(--color-ink-2);
    font-family: var(--font-mono);
    font-size: var(--text-0);
    background: transparent;
    padding: 0 var(--space-1);
    border: var(--rule-1) solid var(--color-rule-soft);
  }
  .search-label input {
    width: 100%;
    min-height: var(--tap);
    padding: var(--space-2) var(--space-3);
    border: var(--rule-2) solid var(--color-ink);
    border-radius: 0;
    background: transparent;
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-3);
    font-weight: 600;
  }
  .search-label input::placeholder {
    color: var(--color-ink-3);
  }

  /* ---------- Two-column layout (specs/uplift-v2-handoff.md §2) ---------- */
  /* The persistent sidebar replaces the per-category add-filter popovers
     above --bp-sidebar (800px). Below that, .sidebar-col is hidden and the
     filter affordance moves to the .filters-button + FilterSheet. */
  .layout-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--space-4);
    margin-block-end: var(--space-5);
  }
  .sidebar-col { display: none; }
  .main-col { min-width: 0; }

  .filters-button {
    display: inline-flex;
    align-items: center;
    min-height: var(--tap);
    padding: 0 var(--space-3);
    border: var(--rule-2) solid var(--color-ink);
    border-radius: 0;
    background: var(--color-paper);
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    cursor: pointer;
  }
  .filters-button:hover { background: var(--color-ink); color: var(--color-paper); }

  /* The breakpoint media block lives AFTER the base .filters-button rule
     so its `display: none` wins on cascade source-order grounds (Svelte
     scope-hashes both rules with equal specificity, so order decides). */
  @media (min-width: 800px) {
    .layout-grid {
      /* Sidebar needs ~ 320 px to fit "GREENHOUSE 38" + "LEVER 1" + "ASHBY 1"
         on one row without horizontal overflow. min-width: 0 on the column
         lets the inner aside obey the column max instead of being expanded
         by chip-list min-content. overflow-x:hidden is a belt-and-braces
         clip in case a single chip ever grows wider than the column.
         (specs/uplift-v2-handoff.md §2 / first-deploy regression fix.) */
      grid-template-columns: minmax(280px, 340px) 1fr;
    }
    .sidebar-col {
      display: block;
      position: sticky;
      top: var(--space-3);
      align-self: start;
      /* No max-height / overflow-y here on purpose: an internal scrollbar
         on top of the page scroll reads as a second scroll context, which
         is jarring. The accordion-collapsed sidebar (FilterGroups defaults
         to ATS + Level open, the rest collapsed) keeps its natural height
         under typical viewports. On the rare case where a user expands
         everything and the sidebar exceeds viewport height, the bottom
         simply scrolls into view as the user scrolls the page — sticky
         positioning still anchors the top. */
      overflow-x: hidden;
      min-width: 0;
    }
    .filters-button { display: none; }
  }

  /* ---------- Filter bar (applied chips + add-filter buttons) ---------- */
  .filter-bar {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    padding-block: var(--space-3);
    border-bottom: var(--rule-1) solid var(--color-rule);
    margin-block-end: var(--space-2);
  }

  .active-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-3);
    min-height: var(--tap);
    border: var(--rule-1) solid var(--color-ink);
    border-radius: 0;
    background: var(--color-ink);
    color: var(--color-paper);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    cursor: pointer;
  }
  .active-chip.accent {
    background: var(--color-accent);
    border-color: var(--color-accent);
    color: var(--color-on-accent);
  }
  .active-chip:hover {
    background: var(--color-accent);
    border-color: var(--color-accent);
    color: var(--color-on-accent);
  }
  .active-chip .x { font-size: var(--text-2); line-height: 1; }

  .add-button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    min-height: var(--tap);
    padding: 0 var(--space-3);
    border: var(--rule-1) dashed var(--color-ink);
    border-radius: 0;
    background: var(--color-paper);
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    cursor: pointer;
  }
  .add-button[aria-expanded="true"],
  .add-button[aria-pressed="true"] {
    background: var(--color-ink);
    color: var(--color-paper);
    border-style: solid;
  }
  .add-button:hover {
    background: var(--color-ink);
    color: var(--color-paper);
    border-style: solid;
  }

  .reset {
    margin-inline-start: auto;
    min-height: var(--tap);
    padding: 0 var(--space-3);
    border: 0;
    background: transparent;
    color: var(--color-accent);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    cursor: pointer;
  }
  .reset:hover {
    text-decoration: underline;
    text-decoration-thickness: 2px;
    text-underline-offset: 0.15em;
  }

  /* ---------- Popover ---------- */
  .popover-anchor {
    position: relative;
    display: inline-flex;
  }

  .popover {
    position: absolute;
    top: calc(100% + var(--space-1));
    left: 0;
    z-index: 50;
    min-width: 240px;
    max-width: calc(100vw - var(--space-4) * 2);
    padding: var(--space-3);
    background: var(--color-paper);
    border: var(--rule-2) solid var(--color-ink);
    box-shadow: var(--space-1) var(--space-1) 0 0 var(--color-ink);
  }
  .popover--narrow { min-width: 200px; }
  .popover--right { right: 0; left: auto; }

  .chip-grid {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    max-width: 360px;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-3);
    min-height: var(--tap);
    border: var(--rule-1) solid var(--color-ink);
    border-radius: 0;
    background: var(--color-paper);
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    cursor: pointer;
  }
  .chip:has(input:checked) {
    background: var(--color-ink);
    color: var(--color-paper);
  }
  .chip input { accent-color: var(--color-accent); }

  .radio-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-1);
  }
  .radio {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-2);
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-2);
    cursor: pointer;
    min-height: var(--tap);
  }
  .radio:hover { background: var(--color-paper); }
  .radio input { accent-color: var(--color-accent); }

  .number-label {
    display: grid;
    gap: var(--space-2);
    color: var(--color-ink-2);
    font-family: var(--font-display);
    font-size: var(--text-00);
    font-weight: 700;
    letter-spacing: var(--track-wider);
    text-transform: uppercase;
  }
  .number-label input {
    min-height: var(--tap);
    padding: 0 var(--space-3);
    border: var(--rule-1) solid var(--color-ink);
    background: var(--color-paper);
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-2);
    font-weight: 600;
  }

  /* ---------- Status / states ---------- */
  .results-status {
    margin: var(--space-3) 0;
    padding: 0;
    color: var(--color-ink-2);
    font-family: var(--font-mono);
    font-size: var(--text-0);
    letter-spacing: var(--track-wider);
    text-transform: uppercase;
  }
  .results-status b { color: var(--color-accent); font-weight: 700; }
  .results-status .status-scope { color: var(--color-accent); font-weight: 700; }

  /* Animated dot before the LOADING ROLES text. Pulses ink → accent →
     ink so motion is visible against the page bg in both themes. The
     1.2 s cycle matches the rhythm of a typical filter pass; honors
     prefers-reduced-motion by holding solid accent instead of pulsing. */
  .busy-dot {
    display: inline-block;
    width: 0.55em;
    height: 0.55em;
    margin-inline-end: 0.5em;
    border-radius: 50%;
    background: var(--color-accent);
    transform: translateY(-0.05em);
    animation: busy-pulse 1.2s ease-in-out infinite;
  }
  @keyframes busy-pulse {
    0%, 100% { opacity: 0.35; transform: translateY(-0.05em) scale(0.85); }
    50%      { opacity: 1;    transform: translateY(-0.05em) scale(1.05); }
  }
  @media (prefers-reduced-motion: reduce) {
    .busy-dot { animation: none; opacity: 1; }
  }

  .data-pending,
  .data-empty {
    padding: var(--space-4) 0;
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-size: var(--text-1);
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
  }

  .data-error {
    padding: var(--space-3);
    margin-block: var(--space-3);
    color: var(--color-on-accent);
    background: var(--color-accent);
    border: var(--rule-1) solid var(--color-accent);
    font-family: var(--font-mono);
    font-size: var(--text-1);
    letter-spacing: var(--track-wide);
  }

  /* ---------- Result list ---------- */
  .results-head { display: none; }

  .results {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 0;
    border-top: var(--rule-2) solid var(--color-rule);
  }

  .job {
    padding: var(--space-4) 0;
    border-bottom: var(--rule-1) solid var(--color-rule);
    display: grid;
    gap: var(--space-2);
  }
  .job.applied { opacity: 0.7; }

  /* Company name is the byline / publisher mark for the row. Smaller mono
     caps in accent red — distinct color and family from the role title so
     users don't conflate the two. */
  .company {
    margin: 0;
    color: var(--color-accent);
    font-family: var(--font-mono);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wider);
    line-height: 1.2;
    text-transform: uppercase;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: baseline;
  }
  .company-name { color: var(--color-accent); }
  .new-badge {
    color: var(--color-accent);
    font-family: var(--font-mono);
    font-size: var(--text-00);
    font-weight: 700;
    letter-spacing: var(--track-wider);
    border: var(--rule-1) solid var(--color-accent);
    padding: 0 var(--space-1);
  }
  .recruiter-badge {
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-size: var(--text-00);
    font-weight: 700;
    letter-spacing: var(--track-wider);
  }
  /* Applied badge — same chip-style frame as NEW / STALE / RECRUITER,
     coloured with the on-accent palette so it reads as a personal
     state marker (not a system state like NEW or STALE). Sits inline
     in the company headline alongside the other badges. */
  .applied-badge {
    color: var(--color-on-accent);
    background: var(--color-accent);
    font-family: var(--font-mono);
    font-size: var(--text-00);
    font-weight: 700;
    letter-spacing: var(--track-wider);
    border: var(--rule-1) solid var(--color-accent);
    padding: 0 var(--space-1);
  }

  /* Stale badge — muted ink-3, mono caps, framed in a thin ink-3 border so
     the cue reads as "this is muted state" not "this is decoration". Per
     specs/visual-theme.md §State discipline, muted ink-3 is reserved for
     negative-but-not-error states; specs/role-lifecycle.md §Filter
     behavior owns this badge. */
  .stale-badge {
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-size: var(--text-00);
    font-weight: 700;
    letter-spacing: var(--track-wider);
    border: var(--rule-1) solid var(--color-ink-3);
    padding: 0 var(--space-1);
    cursor: help;
  }
  /* Stale rows read as muted via per-child colour overrides rather
     than parent opacity. opacity: 0.6 used to do this work but axe
     correctly samples rendered pixels for contrast: the parent
     opacity desaturated every descendant text colour by ~40 %, which
     pulled the company-name (--color-accent) and stale-badge
     (--color-ink-3) below WCAG AA's 4.5:1 floor. Setting the colours
     explicitly to muted variants keeps the "this row is older" cue
     without dropping rendered contrast. The STALE badge + filter chip
     own the deeper "why is this dim?" question. */
  .job.is-stale .job-title {
    color: var(--color-ink-2);
  }
  .job.is-stale .company-name {
    color: var(--color-ink-3);
  }
  .job.is-stale .job-cell--location,
  .job.is-stale .job-cell--level,
  .job.is-stale .job-cell--posted {
    color: var(--color-ink-3);
  }

  /* Role title is the most prominent element in each row — biggest type,
     primary ink, display sans for at-a-glance scanability. The company
     above it is in accent red mono so the two never visually merge. */
  .job-title {
    display: inline-block;
    margin-top: var(--space-1);
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-4);
    font-weight: 800;
    letter-spacing: var(--track-tight);
    line-height: 1.1;
    text-transform: uppercase;
    text-decoration: none;
  }
  .job-title:hover {
    color: var(--color-accent);
    text-decoration: underline;
    text-decoration-thickness: 2px;
    text-underline-offset: 0.15em;
  }
  @media (min-width: 768px) {
    .job-title { font-size: var(--text-5); }
  }
  @media (min-width: 960px) {
    .job-title { font-size: var(--text-4); }
  }

  .job-cell--location {
    color: var(--color-ink-2);
    font-family: var(--font-serif);
    font-size: var(--text-2);
  }
  .job-cell--location .wt {
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-size: var(--text-1);
    letter-spacing: var(--track-wide);
    color: var(--color-ink-2);
  }
  .job-cell--location .rule { color: var(--color-ink-3); }

  .job-cell--level {
    color: var(--color-ink-2);
    font-family: var(--font-mono);
    font-size: var(--text-1);
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
  }
  .job-cell--posted {
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-size: var(--text-0);
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    display: flex;
    gap: var(--space-2);
    align-items: baseline;
    min-width: 0;
  }
  .job-cell--posted .age.is-new::before { content: "● "; color: var(--color-accent); }

  /* On mobile cells stack; collapse empty ones so we don't show stray
     placeholders between data lines. On desktop the grid keeps the
     placeholder reserved (visibility:hidden) so columns stay aligned. */
  .job-cell.is-empty { display: none; }
  @media (min-width: 960px) {
    .job-cell.is-empty { display: block; visibility: hidden; }
  }

  /* ---------- Row actions ----------
     Apply is the primary action — solid accent, slightly taller, the
     visual anchor of the row. Save / Ignore are secondary controls
     with a quieter outline style; their "active" state colors the
     text + border (accent for saved, muted ink for ignored) without
     filling with ink which would compete with the Apply button. */
  /* Three-weight action cluster: Apply is the loud filled-accent CTA;
     Save and Ignore are square glyph-only tap targets (☆/★ and ×/↺
     respectively). Strict no-wrap so a tight Posted column can't push
     a button below the row, which is what was overlapping Posted. */
  .job-actions {
    display: flex;
    flex-wrap: nowrap;
    gap: var(--space-1);
    align-items: center;
    justify-content: flex-end;
  }
  .job-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: var(--tap);
    border-radius: 0;
    font-family: var(--font-display);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    text-decoration: none;
    cursor: pointer;
    transition:
      color 120ms ease-out,
      border-color 120ms ease-out,
      background-color 120ms ease-out;
  }
  /* Apply — primary CTA. Filled accent, arrow glyph, min-width so it
     stays on a single line regardless of the surrounding labels. */
  .job-action.apply {
    padding: 0 var(--space-3);
    background: var(--color-accent);
    color: var(--color-on-accent);
    border: var(--rule-1) solid var(--color-accent);
    font-size: var(--text-1);
    min-width: 5.5rem;
  }
  .job-action.apply:hover {
    background: var(--color-ink);
    border-color: var(--color-ink);
    color: var(--color-paper);
  }
  /* Save — square glyph-only tap target. The ☆/★ glyph IS the button.
     Default state stays quiet (transparent / ink-3); the saved state
     paints the star accent so it reads as "marked" at a glance. */
  .job-action.save {
    width: var(--tap);
    padding: 0;
    background: transparent;
    color: var(--color-ink-3);
    border: 0;
    font-size: var(--text-3);
    line-height: 1;
  }
  .job-action.save:hover:not(:disabled) {
    color: var(--color-ink);
  }
  .job-action.save[aria-pressed="true"] {
    color: var(--color-accent);
  }
  .job-action.save[aria-pressed="true"]:hover {
    color: var(--color-ink);
  }
  /* Ignore — square glyph-only tap target, mirror of Save. × dismisses
     (default), ↺ restores (active). Ink-3 ambient color → ink on hover
     → accent when ignored to mark it as "you've dismissed this". */
  .job-action.ignore {
    width: var(--tap);
    padding: 0;
    background: transparent;
    color: var(--color-ink-3);
    border: 0;
    font-size: var(--text-3);
    line-height: 1;
  }
  .job-action.ignore:hover:not(:disabled) {
    color: var(--color-ink);
  }
  .job-action.ignore[aria-pressed="true"] {
    color: var(--color-accent);
  }
  .job-action.ignore[aria-pressed="true"]:hover {
    color: var(--color-ink);
  }

  /* ---------- Pager ----------
     Single-row layout. Below 640 px the numbered list collapses to a
     compact "PAGE N OF M" summary so prev/next stay reachable on the
     same row at every viewport. Buttons are centered as a tight group. */
  .pager {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-1);
    padding-block: var(--space-4);
    margin-block-start: var(--space-4);
    border-top: var(--rule-4) solid var(--color-rule);
  }
  .pager-edge,
  .pager-page {
    min-height: var(--tap);
    min-width: var(--tap);
    padding: 0 var(--space-3);
    border: var(--rule-1) solid var(--color-ink);
    border-radius: 0;
    background: var(--color-paper);
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    cursor: pointer;
  }
  .pager-edge:hover:not(:disabled),
  .pager-page:hover { background: var(--color-ink); color: var(--color-paper); }
  .pager-edge:disabled { opacity: 0.4; cursor: not-allowed; }
  .pager-pages {
    display: none; /* mobile default: replaced by .pager-summary */
  }
  .pager-summary {
    /* On mobile the summary fills the gap between prev and next so the
       three controls span the available row width. */
    flex: 1 1 auto;
    text-align: center;
    padding-inline: var(--space-2);
    color: var(--color-ink-2);
    font-family: var(--font-mono);
    font-size: var(--text-1);
    letter-spacing: var(--track-wider);
    text-transform: uppercase;
  }
  .pager-summary b { color: var(--color-accent); font-weight: 700; }
  .pager-page.is-current {
    background: var(--color-accent);
    color: var(--color-on-accent);
    border-color: var(--color-accent);
  }
  .pager-ellipsis {
    align-self: center;
    padding: 0 var(--space-2);
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-size: var(--text-0);
  }

  @media (min-width: 640px) {
    .pager-pages {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      gap: var(--space-1);
    }
    .pager-summary { display: none; }
  }

  /* ---------- Desktop layout: results as a table-grid with sortable columns ---------- */
  @media (min-width: 960px) {
    .results-head,
    .job {
      display: grid;
      /* role · location · level · posted · actions
         Actions is now a fixed-content column (Apply CTA + two glyph
         buttons) so it shrinks to its content rather than competing
         with role/location for fr-share. Posted gets a hair more room
         so "13D" never collides with the action cluster. */
      grid-template-columns:
        minmax(0, 2.4fr)
        minmax(0, 1.5fr)
        minmax(0, 0.7fr)
        minmax(0, 0.85fr)
        auto;
      column-gap: var(--space-3);
      align-items: start;
      padding-block: var(--space-3);
    }
    /* Defensive cell clipping. Every grid cell must obey its column max
       — without this, a long single-token field like a 30-char level
       value or a no-spaces title could expand its cell and visually
       overlap the next column. min-width:0 lets the grid shrink the
       cell below content min-content width; overflow:hidden + ellipsis
       keep any escaped string inside its own column. */
    .job > .job-cell {
      min-width: 0;
      overflow: hidden;
    }
    .job-cell--location,
    .job-cell--level,
    .job-cell--posted {
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .results-head {
      display: grid;
      padding-block: var(--space-2);
      border-block: var(--rule-2) solid var(--color-rule);
    }
    .col-head {
      padding: 0;
      margin: 0;
      border: 0;
      background: transparent;
      color: var(--color-ink);
      font-family: var(--font-display);
      font-size: var(--text-00);
      font-weight: 800;
      letter-spacing: var(--track-wider);
      text-transform: uppercase;
      text-align: left;
      cursor: pointer;
      min-height: var(--tap);
    }
    .col-head:not(button) { cursor: default; }
    .col-head .arr { color: var(--color-accent); margin-left: var(--space-1); }

    .results { border-top: 0; }
    .job {
      gap: 0;
      border-bottom: var(--rule-1) solid var(--color-rule);
    }
    .job-cell { font-family: var(--font-serif); font-size: var(--text-2); }
    .job-cell--role { display: grid; gap: var(--space-1); }
    .job-cell--actions { justify-self: end; }
    /* Mobile: keep actions on one line and tighten the gap; each action
       variant (apply / save / ignore) keeps its own padding + font-size
       so the M3 visual hierarchy survives the breakpoint. */
    .job-actions { flex-wrap: nowrap; gap: var(--space-1); }
    .job-action.apply { padding: 0 var(--space-2); }
  }
</style>
