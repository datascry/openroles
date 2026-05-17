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
 * - `loading`            → indeterminate (manifest not parsed yet, no counts)
 * - `loading-progressive`→ determinate when chunksTotal known, else indeterminate
 * - `ready` + query running → indeterminate ("Filtering…" on the 750k-row pass)
 * - `ready` (idle)       → hidden
 * - `error`              → hidden (the error surfaces in the results banner)
 *
 * `fraction` is clamped to [0,1]; a zero/negative `chunksTotal` falls
 * back to indeterminate rather than dividing by zero.
 */
export function loadProgress(
  dbStatus: DbStatus,
  chunksLoaded: number,
  chunksTotal: number,
  isQueryRunning: boolean,
): LoadProgress {
  if (dbStatus === "error") return HIDDEN;

  if (dbStatus === "ready") {
    if (isQueryRunning) {
      return { visible: true, indeterminate: true, fraction: 0, label: "Filtering…" };
    }
    return HIDDEN;
  }

  if (dbStatus === "loading") {
    return { visible: true, indeterminate: true, fraction: 0, label: "Loading…" };
  }

  // loading-progressive
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
