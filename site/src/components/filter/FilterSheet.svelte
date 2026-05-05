<script lang="ts">
import { totalActiveCount } from "../../lib/filter-active-count.ts";
import { DEFAULT_FILTER_STATE, type FilterState } from "../../lib/filter-state.ts";
import FilterGroups from "./FilterGroups.svelte";

interface Props {
  filters: FilterState;
  onPatch: (patch: Partial<FilterState>) => void;
  resultCount: number;
  savedCount: number;
  appliedCount: number;
  ignoredCount: number;
  optionCounts?: {
    ats: Record<string, number>;
    level: Record<string, number>;
    wt: Record<string, number>;
  };
  open: boolean;
  /** While true, the apply button shows "Updating…" — a query is in flight. */
  loading?: boolean;
  onClose: () => void;
}

let {
  filters,
  onPatch,
  resultCount,
  savedCount,
  appliedCount,
  ignoredCount,
  optionCounts,
  open,
  loading = false,
  onClose,
}: Props = $props();

let dialogEl: HTMLDivElement | null = $state(null);
let closeBtnEl: HTMLButtonElement | null = $state(null);
let lastFocus: HTMLElement | null = null;
let confirmingReset = $state(false);

const activeCount = $derived(totalActiveCount(filters));

// The dialog DOM is always mounted so opening costs only a CSS transition,
// not a Svelte mount of seven groups + ~50 chips. The keydown listener
// attaches only while open.
$effect(() => {
  if (!open) return;
  if (typeof document === "undefined") return;
  lastFocus = document.activeElement as HTMLElement | null;
  queueMicrotask(() => closeBtnEl?.focus());

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    if (!dialogEl) return;
    const focusable = dialogEl.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0] as HTMLElement;
    const last = focusable[focusable.length - 1] as HTMLElement;
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // Spec §2.7.j — when an input inside the sheet is focused on a touch
  // device, the on-screen keyboard pops up and can obscure the field.
  // Scroll the focused field into the centre of the visible viewport.
  function onFocusIn(e: FocusEvent) {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (!t.matches("input, select, textarea, button")) return;
    queueMicrotask(() => t.scrollIntoView({ block: "center", behavior: "auto" }));
  }

  // Spec §2.7.i — pushing a history entry on open lets the back button
  // close the sheet rather than navigating away from the page.
  let pushedHistory = false;
  let closedByPopstate = false;
  if (typeof window !== "undefined" && window.history) {
    window.history.pushState({ openroles: "filter-sheet" }, "");
    pushedHistory = true;
  }
  function onPopState() {
    closedByPopstate = true;
    onClose();
  }
  if (typeof window !== "undefined") {
    window.addEventListener("popstate", onPopState);
  }

  document.addEventListener("keydown", onKey);
  document.addEventListener("focusin", onFocusIn);
  return () => {
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("focusin", onFocusIn);
    if (typeof window !== "undefined") {
      window.removeEventListener("popstate", onPopState);
      // Only pop our pushed entry when the close was NOT driven by the
      // back button (otherwise we'd navigate back twice).
      if (pushedHistory && !closedByPopstate) {
        const stateMatches =
          (window.history.state as { openroles?: string } | null)?.openroles === "filter-sheet";
        if (stateMatches) window.history.back();
      }
    }
    lastFocus?.focus?.();
  };
});

function onResetClick() {
  if (activeCount >= 3) {
    confirmingReset = true;
  } else {
    doReset();
  }
}
function doReset() {
  confirmingReset = false;
  onPatch({ ...DEFAULT_FILTER_STATE });
}
function cancelReset() {
  confirmingReset = false;
}

function onOverlayClick(e: MouseEvent) {
  if (e.target === e.currentTarget) onClose();
}
</script>

<div
  class="overlay"
  class:is-open={open}
  role="presentation"
  aria-hidden={!open}
  onclick={onOverlayClick}
>
  <div
    class="sheet"
    role="dialog"
    aria-modal="true"
    aria-label="Filters"
    aria-hidden={!open}
    inert={!open}
    bind:this={dialogEl}
  >
    <header class="sheet-head">
      <h2 class="sheet-title">Filters{activeCount > 0 ? ` · ${activeCount}` : ""}</h2>
      <button
        type="button"
        class="close-btn"
        onclick={onClose}
        aria-label="Close filters"
        tabindex={open ? 0 : -1}
        bind:this={closeBtnEl}
      >Close</button>
    </header>

    <div class="sheet-body">
      <FilterGroups
        filters={filters}
        onPatch={onPatch}
        savedCount={savedCount}
        appliedCount={appliedCount}
        ignoredCount={ignoredCount}
        optionCounts={optionCounts}
        collapsible={true}
      />
    </div>

    <footer class="sheet-foot">
      {#if confirmingReset}
        <div class="reset-confirm" role="alertdialog" aria-label="Reset all filters?">
          <span class="reset-q">Reset all filters?</span>
          <button type="button" class="reset-yes" onclick={doReset}>Yes</button>
          <button type="button" class="reset-cancel" onclick={cancelReset}>Cancel</button>
        </div>
      {:else}
        <button
          type="button"
          class="reset"
          disabled={activeCount === 0}
          tabindex={open ? 0 : -1}
          onclick={onResetClick}
        >Reset</button>
        <button
          type="button"
          class="apply"
          aria-disabled={loading}
          tabindex={open ? 0 : -1}
          onclick={onClose}
        >
          {#if loading}
            Updating…
          {:else}
            Show <span aria-live="polite">{resultCount.toLocaleString()}</span> {resultCount === 1 ? "role" : "roles"}
          {/if}
        </button>
      {/if}
    </footer>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgba(10, 10, 10, 0);
    display: flex;
    align-items: flex-end;
    justify-content: stretch;
    visibility: hidden;
    pointer-events: none;
    transition:
      background-color 120ms ease-in,
      visibility 0s linear 120ms;
  }
  .overlay.is-open {
    background: rgba(10, 10, 10, 0.4);
    visibility: visible;
    pointer-events: auto;
    transition:
      background-color 180ms cubic-bezier(0.25, 0, 0.4, 1),
      visibility 0s linear 0s;
  }

  .sheet {
    background: var(--color-paper);
    border-top: var(--rule-4) solid var(--color-ink);
    width: 100%;
    max-height: 90vh;
    display: grid;
    grid-template-rows: auto 1fr auto;
    transform: translateY(100%);
    transition: transform 120ms ease-in;
    will-change: transform;
  }
  .overlay.is-open .sheet {
    transform: translateY(0);
    transition: transform 180ms cubic-bezier(0.25, 0, 0.4, 1);
  }

  .sheet-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: var(--space-3);
    border-bottom: var(--rule-2) solid var(--color-ink);
  }
  .sheet-title {
    margin: 0;
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-3);
    font-weight: 800;
    letter-spacing: var(--track-tight);
    text-transform: uppercase;
  }
  .close-btn {
    appearance: none;
    background: transparent;
    border: 0;
    padding: 0 var(--space-2);
    min-height: var(--tap);
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    cursor: pointer;
  }
  .close-btn:hover { color: var(--color-accent); }

  .sheet-body {
    padding: var(--space-3);
    overflow-y: auto;
  }

  .sheet-foot {
    display: grid;
    grid-template-columns: 1fr 1.4fr;
    gap: var(--space-2);
    padding: var(--space-3);
    padding-bottom: max(var(--space-3), env(safe-area-inset-bottom));
    border-top: var(--rule-2) solid var(--color-ink);
    background: var(--color-paper);
  }
  .sheet-foot .reset,
  .sheet-foot .apply {
    min-height: var(--tap);
    border-radius: 0;
    border: var(--rule-1) solid var(--color-ink);
    background: var(--color-paper);
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    cursor: pointer;
  }
  .sheet-foot .apply {
    background: var(--color-accent);
    border-color: var(--color-accent);
    color: var(--color-on-accent);
    font-size: var(--text-2);
  }
  .sheet-foot .apply:hover { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-paper); }
  .sheet-foot .reset:disabled { opacity: 0.5; cursor: not-allowed; }
  .sheet-foot .apply[aria-disabled="true"] { opacity: 0.7; cursor: progress; }

  .reset-confirm {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2);
    border: var(--rule-2) solid var(--color-accent);
    background: var(--color-accent-soft);
  }
  .reset-q {
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    flex: 1 1 100%;
  }
  .reset-yes,
  .reset-cancel {
    min-height: var(--tap);
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
  .reset-yes {
    background: var(--color-accent);
    border-color: var(--color-accent);
    color: var(--color-on-accent);
  }
</style>
