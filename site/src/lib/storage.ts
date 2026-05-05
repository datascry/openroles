export interface SavedJobs {
  readonly version: 1;
  readonly ids: ReadonlyArray<string>;
}

export interface AppliedJobs {
  readonly version: 1;
  readonly entries: ReadonlyArray<{ readonly id: string; readonly applied_at: string }>;
}

export interface IgnoredJobs {
  readonly version: 1;
  readonly ids: ReadonlyArray<string>;
}

/**
 * Saved-search entry surfaced by the dual-mode search bar
 * (specs/uplift-v2-handoff.md §1.3). The stored `mode` lets the bar
 * restore the originating tab when re-applied so structured queries
 * don't snap back to free-text.
 */
export type SavedSearchMode = "free" | "structured";

export interface SavedSearch {
  readonly id: string;
  readonly label: string;
  readonly q: string;
  readonly mode: SavedSearchMode;
  readonly created_at: string;
}

export interface SavedSearches {
  readonly version: 1;
  readonly entries: ReadonlyArray<SavedSearch>;
}

/** UI-enforced cap on saved-search labels (search-bar UX cap). */
export const SAVED_SEARCH_LABEL_MAX = 64;
/** Hard cap on stored saved-searches; oldest are evicted on overflow. */
export const SAVED_SEARCH_LIMIT = 20;

const NS = "openroles:v1";

export const STORAGE_KEYS = {
  saved: `${NS}:saved`,
  applied: `${NS}:applied`,
  ignored: `${NS}:ignored`,
  savedSearches: `${NS}:saved-searches`,
} as const;

// Accepts the canonical 16-char short_id form (Phase 14, slim-index)
// AND the legacy 64-char full Job.id (pre-Phase-14 saves) so migrating
// users don't lose their saved/applied/ignored history. We normalise
// everything to 16-char on load.
const HEX_ID_RE = /^[0-9a-f]{16}([0-9a-f]{48})?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function normalizeId(id: string): string {
  return id.slice(0, 16);
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function readJson<T>(
  storage: StorageLike,
  key: string,
  parse: (raw: unknown) => T | null,
): T | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  try {
    return parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseSaved(raw: unknown): SavedJobs | null {
  if (!isObject(raw) || raw["version"] !== 1) return null;
  const ids = raw["ids"];
  if (!Array.isArray(ids)) return null;
  const valid = ids
    .filter((id): id is string => typeof id === "string" && HEX_ID_RE.test(id))
    .map(normalizeId);
  return { version: 1, ids: valid };
}

function parseApplied(raw: unknown): AppliedJobs | null {
  if (!isObject(raw) || raw["version"] !== 1) return null;
  const entries = raw["entries"];
  if (!Array.isArray(entries)) return null;
  const valid = entries
    .filter((e): e is { id: string; applied_at: string } => {
      if (!isObject(e)) return false;
      const id = e["id"];
      const at = e["applied_at"];
      return (
        typeof id === "string" && HEX_ID_RE.test(id) && typeof at === "string" && ISO_RE.test(at)
      );
    })
    .map((e) => ({ id: normalizeId(e.id), applied_at: e.applied_at }));
  return { version: 1, entries: valid };
}

function parseIgnored(raw: unknown): IgnoredJobs | null {
  if (!isObject(raw) || raw["version"] !== 1) return null;
  const ids = raw["ids"];
  if (!Array.isArray(ids)) return null;
  const valid = ids
    .filter((id): id is string => typeof id === "string" && HEX_ID_RE.test(id))
    .map(normalizeId);
  return { version: 1, ids: valid };
}

export function loadSaved(storage: StorageLike): SavedJobs {
  return readJson(storage, STORAGE_KEYS.saved, parseSaved) ?? { version: 1, ids: [] };
}

export function loadApplied(storage: StorageLike): AppliedJobs {
  return readJson(storage, STORAGE_KEYS.applied, parseApplied) ?? { version: 1, entries: [] };
}

export function loadIgnored(storage: StorageLike): IgnoredJobs {
  return readJson(storage, STORAGE_KEYS.ignored, parseIgnored) ?? { version: 1, ids: [] };
}

function writeSaved(storage: StorageLike, value: SavedJobs): void {
  storage.setItem(STORAGE_KEYS.saved, JSON.stringify(value));
}

function writeApplied(storage: StorageLike, value: AppliedJobs): void {
  storage.setItem(STORAGE_KEYS.applied, JSON.stringify(value));
}

function writeIgnored(storage: StorageLike, value: IgnoredJobs): void {
  storage.setItem(STORAGE_KEYS.ignored, JSON.stringify(value));
}

export function toggleSaved(storage: StorageLike, id: string): boolean {
  if (!HEX_ID_RE.test(id)) return false;
  const norm = normalizeId(id);
  const current = loadSaved(storage);
  const has = current.ids.includes(norm);
  const next: SavedJobs = has
    ? { version: 1, ids: current.ids.filter((x) => x !== norm) }
    : { version: 1, ids: [...current.ids, norm] };
  writeSaved(storage, next);
  return !has;
}

export function markApplied(storage: StorageLike, id: string, appliedAt: string): boolean {
  if (!HEX_ID_RE.test(id)) return false;
  if (!ISO_RE.test(appliedAt)) return false;
  const norm = normalizeId(id);
  const current = loadApplied(storage);
  if (current.entries.some((e) => e.id === norm)) return false;
  const next: AppliedJobs = {
    version: 1,
    entries: [...current.entries, { id: norm, applied_at: appliedAt }],
  };
  writeApplied(storage, next);
  return true;
}

export function unmarkApplied(storage: StorageLike, id: string): boolean {
  if (!HEX_ID_RE.test(id)) return false;
  const norm = normalizeId(id);
  const current = loadApplied(storage);
  if (!current.entries.some((e) => e.id === norm)) return false;
  const next: AppliedJobs = { version: 1, entries: current.entries.filter((e) => e.id !== norm) };
  writeApplied(storage, next);
  return true;
}

export function toggleIgnored(storage: StorageLike, id: string): boolean {
  if (!HEX_ID_RE.test(id)) return false;
  const norm = normalizeId(id);
  const current = loadIgnored(storage);
  const has = current.ids.includes(norm);
  const next: IgnoredJobs = has
    ? { version: 1, ids: current.ids.filter((x) => x !== norm) }
    : { version: 1, ids: [...current.ids, norm] };
  writeIgnored(storage, next);
  return !has;
}

// ---------------------------------------------------------------------------
// Saved searches (specs/uplift-v2-handoff.md §1.3)
// ---------------------------------------------------------------------------

const SAVED_SEARCH_ID_RE = /^[a-z0-9]{8,32}$/;

function parseSavedSearches(raw: unknown): SavedSearches | null {
  if (!isObject(raw) || raw["version"] !== 1) return null;
  const entries = raw["entries"];
  if (!Array.isArray(entries)) return null;
  const valid: SavedSearch[] = [];
  for (const e of entries) {
    if (!isObject(e)) continue;
    const id = e["id"];
    const label = e["label"];
    const q = e["q"];
    const mode = e["mode"];
    const createdAt = e["created_at"];
    if (typeof id !== "string" || !SAVED_SEARCH_ID_RE.test(id)) continue;
    if (typeof label !== "string" || label.length === 0 || label.length > SAVED_SEARCH_LABEL_MAX) {
      continue;
    }
    if (typeof q !== "string") continue;
    if (mode !== "free" && mode !== "structured") continue;
    if (typeof createdAt !== "string" || !ISO_RE.test(createdAt)) continue;
    valid.push({ id, label, q, mode, created_at: createdAt });
  }
  return { version: 1, entries: valid };
}

export function loadSavedSearches(storage: StorageLike): SavedSearches {
  return (
    readJson(storage, STORAGE_KEYS.savedSearches, parseSavedSearches) ?? {
      version: 1,
      entries: [],
    }
  );
}

function writeSavedSearches(storage: StorageLike, value: SavedSearches): void {
  storage.setItem(STORAGE_KEYS.savedSearches, JSON.stringify(value));
}

/**
 * Persist a saved search. Trims label, drops over-cap labels, dedupes by
 * (q, mode), and evicts the oldest entry when the cap is hit. Returns the
 * stored entry (or null if input was rejected).
 */
export function saveSavedSearch(
  storage: StorageLike,
  label: string,
  q: string,
  mode: SavedSearchMode,
  now: () => Date = () => new Date(),
): SavedSearch | null {
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > SAVED_SEARCH_LABEL_MAX) return null;
  if (typeof q !== "string" || q.length === 0) return null;
  if (mode !== "free" && mode !== "structured") return null;
  const current = loadSavedSearches(storage);
  // Dedupe by (q, mode); replace its entry rather than create a duplicate.
  const filtered = current.entries.filter((e) => !(e.q === q && e.mode === mode));
  const id = randomId();
  const entry: SavedSearch = {
    id,
    label: trimmed,
    q,
    mode,
    created_at: now().toISOString(),
  };
  // Newest first, capped.
  const next = [entry, ...filtered].slice(0, SAVED_SEARCH_LIMIT);
  writeSavedSearches(storage, { version: 1, entries: next });
  return entry;
}

export function removeSavedSearch(storage: StorageLike, id: string): boolean {
  if (!SAVED_SEARCH_ID_RE.test(id)) return false;
  const current = loadSavedSearches(storage);
  if (!current.entries.some((e) => e.id === id)) return false;
  const next: SavedSearches = {
    version: 1,
    entries: current.entries.filter((e) => e.id !== id),
  };
  writeSavedSearches(storage, next);
  return true;
}

function randomId(): string {
  // Lower-case base36 from crypto.getRandomValues when available, otherwise
  // fall back to Math.random — id collisions only matter for the active
  // user's own browser, and 12 hex chars is comfortably unique for 20
  // entries.
  const bytes = new Uint8Array(8);
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
