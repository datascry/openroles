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

const NS = "openroles:v1";

export const STORAGE_KEYS = {
  saved: `${NS}:saved`,
  applied: `${NS}:applied`,
  ignored: `${NS}:ignored`,
} as const;

const HEX_ID_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

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
  const valid = ids.filter((id): id is string => typeof id === "string" && HEX_ID_RE.test(id));
  return { version: 1, ids: valid };
}

function parseApplied(raw: unknown): AppliedJobs | null {
  if (!isObject(raw) || raw["version"] !== 1) return null;
  const entries = raw["entries"];
  if (!Array.isArray(entries)) return null;
  const valid = entries.filter((e): e is { id: string; applied_at: string } => {
    if (!isObject(e)) return false;
    const id = e["id"];
    const at = e["applied_at"];
    return (
      typeof id === "string" && HEX_ID_RE.test(id) && typeof at === "string" && ISO_RE.test(at)
    );
  });
  return { version: 1, entries: valid };
}

function parseIgnored(raw: unknown): IgnoredJobs | null {
  if (!isObject(raw) || raw["version"] !== 1) return null;
  const ids = raw["ids"];
  if (!Array.isArray(ids)) return null;
  const valid = ids.filter((id): id is string => typeof id === "string" && HEX_ID_RE.test(id));
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
  const current = loadSaved(storage);
  const has = current.ids.includes(id);
  const next: SavedJobs = has
    ? { version: 1, ids: current.ids.filter((x) => x !== id) }
    : { version: 1, ids: [...current.ids, id] };
  writeSaved(storage, next);
  return !has;
}

export function markApplied(storage: StorageLike, id: string, appliedAt: string): boolean {
  if (!HEX_ID_RE.test(id)) return false;
  if (!ISO_RE.test(appliedAt)) return false;
  const current = loadApplied(storage);
  if (current.entries.some((e) => e.id === id)) return false;
  const next: AppliedJobs = {
    version: 1,
    entries: [...current.entries, { id, applied_at: appliedAt }],
  };
  writeApplied(storage, next);
  return true;
}

export function unmarkApplied(storage: StorageLike, id: string): boolean {
  if (!HEX_ID_RE.test(id)) return false;
  const current = loadApplied(storage);
  if (!current.entries.some((e) => e.id === id)) return false;
  const next: AppliedJobs = { version: 1, entries: current.entries.filter((e) => e.id !== id) };
  writeApplied(storage, next);
  return true;
}

export function toggleIgnored(storage: StorageLike, id: string): boolean {
  if (!HEX_ID_RE.test(id)) return false;
  const current = loadIgnored(storage);
  const has = current.ids.includes(id);
  const next: IgnoredJobs = has
    ? { version: 1, ids: current.ids.filter((x) => x !== id) }
    : { version: 1, ids: [...current.ids, id] };
  writeIgnored(storage, next);
  return !has;
}
