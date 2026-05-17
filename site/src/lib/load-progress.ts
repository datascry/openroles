// View-model for the thin progress bar under the search bar. Pure so it
// can be unit-tested at the 95/95/90 floor — the .svelte island only
// renders the returned shape (CLAUDE.md: logic out of .svelte).

export type DbStatus = "loading" | "loading-progressive" | "ready" | "error";

export interface LoadProgress {
  /** Render the bar at all. */
  readonly visible: boolean;
  /** No known fraction → animated sweep instead of a filled width. */
  readonly indeterminate: boolean;
  /** 0–1, only meaningful when `!indeterminate`. */
  readonly fraction: number;
  /** Short status for aria-valuetext / title. */
  readonly label: string;
}

const HIDDEN: LoadProgress = {
  visible: false,
  indeterminate: false,
  fraction: 0,
  label: "",
};

/**
 * Map the table's load/query state onto the bar.
 *
 * Crucial subtlety: `dbStatus` flips to `ready` right after **chunk 0**
 * lands (so the UI is interactive ASAP) while the remaining ~37 chunks
 * stream in the background. So `ready` does NOT mean "done loading" —
 * `fullyLoaded` (driven by slim-index-loader's `onComplete`, which
 * fires only after the background fan-out settles, soft-fails included)
 * is the real terminal signal. Keying the bar off `fullyLoaded`
 * instead of `dbStatus === "ready"` is what keeps it visible through
 * the whole progressive load instead of vanishing the moment the first
 * jobs render.
 *
 * - not loaded yet, no chunk counts (`loading`) → indeterminate sweep
 * - chunks streaming (counts known)             → determinate fill
 * - fully loaded + a filter pass running        → indeterminate
 *   ("Filtering…" on the 750k-row synchronous pass)
 * - fully loaded + idle                         → hidden
 * - `error`                                     → hidden (the banner
 *   owns the message)
 *
 * `fraction` is clamped to [0,1]; a zero/negative/non-finite
 * `chunksTotal` falls back to indeterminate rather than dividing by
 * zero.
 */
export function loadProgress(
  dbStatus: DbStatus,
  chunksLoaded: number,
  chunksTotal: number,
  isQueryRunning: boolean,
  fullyLoaded: boolean,
): LoadProgress {
  if (dbStatus === "error") return HIDDEN;

  if (fullyLoaded) {
    // Everything has settled. The only thing worth surfacing now is a
    // long synchronous filter pass on the full dataset.
    if (isQueryRunning) {
      return { visible: true, indeterminate: true, fraction: 0, label: "Filtering…" };
    }
    return HIDDEN;
  }

  // Still loading (this includes `ready` — interactive but the
  // background chunk fan-out is not done).
  if (dbStatus === "loading") {
    // Manifest not parsed yet → no chunk counts to show.
    return { visible: true, indeterminate: true, fraction: 0, label: "Loading…" };
  }

  if (!Number.isFinite(chunksTotal) || chunksTotal <= 0) {
    return { visible: true, indeterminate: true, fraction: 0, label: "Loading…" };
  }
  const safeLoaded = Number.isFinite(chunksLoaded) && chunksLoaded > 0 ? chunksLoaded : 0;
  const fraction = Math.min(1, Math.max(0, safeLoaded / chunksTotal));
  return {
    visible: true,
    indeterminate: false,
    fraction,
    label: `Loading ${Math.min(safeLoaded, chunksTotal)} of ${chunksTotal}…`,
  };
}
