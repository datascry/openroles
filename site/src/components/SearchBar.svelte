<script lang="ts">
import { untrack } from "svelte";
import {
  composeQuery,
  hasStructured,
  parseQuery,
  Q_FIELD_MAX,
  Q_TOTAL_MAX,
  type StructuredQuery,
} from "../lib/search-dsl.ts";
import { SAVED_SEARCH_LABEL_MAX } from "../lib/storage.ts";

/**
 * Dual-mode search bar with free-text and structured tabs that round-trip
 * through `FilterState.q` (specs/uplift-v2-handoff.md §1).
 *
 * The parent owns the canonical `q` string. Switching tabs mutates the
 * local view (composed/parsed) but does not touch `q` until the user
 * commits (typed in free-text after the 250 ms debounce, or pressed
 * Search in structured mode).
 */
type Mode = "free" | "structured";

interface Props {
  /** Current FilterState.q value. */
  q: string;
  /** Pluralised count for the placeholder ("Search 56 open roles…"). */
  totalRoles?: number;
  /** Triggered with the next q after free-text debounce or structured submit. */
  onChange: (next: string) => void;
  /** Saved searches read from localStorage. Empty array hides the recent row. */
  savedSearches?: ReadonlyArray<{ id: string; label: string; q: string; mode: Mode }>;
  /** Persist the current q + originating tab mode to saved searches. */
  onSaveSearch?: (label: string, q: string, mode: Mode) => void;
  /** Apply a saved search by id (parent loads the stored q). */
  onApplySavedSearch?: (id: string) => void;
  /** Bumped by the parent on each saved-search apply so the mode-restore
   *  effect refires. Initial value is 0; subsequent values must be > 0. */
  applyToken?: number;
  /** The mode the applied saved search was originally edited in. */
  applyMode?: Mode;
}

let {
  q,
  totalRoles,
  onChange,
  savedSearches = [],
  onSaveSearch,
  onApplySavedSearch,
  applyToken = 0,
  applyMode,
}: Props = $props();

const Q_DEBOUNCE_MS = 250;

const initialParsed = parseQuery(q);
const initialMode: Mode =
  hasStructured(initialParsed) && initialParsed.freeText.length === 0 ? "structured" : "free";

let mode = $state<Mode>(initialMode);
let freeText = $state(q);
let structured = $state<StructuredQuery>(initialParsed);
let debounceHandle: ReturnType<typeof setTimeout> | undefined;

let savePromptOpen = $state(false);
let savePromptLabel = $state("");
let savePromptInputEl: HTMLInputElement | null = $state(null);

const placeholder = $derived(
  totalRoles && totalRoles > 0
    ? `Search ${totalRoles.toLocaleString()} open roles…`
    : "Search roles — try title:engineer or company:stripe location:remote",
);

const structuredFooter = $derived(
  mode === "structured" && structured.freeText.length > 0
    ? `+ free text: "${structured.freeText}"`
    : "",
);

// When `q` changes from outside (e.g. saved-search apply, reset), refresh
// the structured slot and the free-text mirror. The body reads `structured`
// inside untrack() so a user edit to a structured field does NOT re-trigger
// the effect (which would parse the outdated `q` and wipe their edit).
$effect(() => {
  const nextQ = q;
  untrack(() => {
    if (nextQ === composeQuery(structured)) return;
    structured = parseQuery(nextQ);
    if (mode === "free") freeText = nextQ;
  });
});

// Apply-saved-search mode coordination: the parent bumps `applyToken` and
// sets `applyMode` when a saved search is applied; we react by switching to
// the originating tab. Read `applyToken` reactively, `applyMode` inside
// untrack so a stale token doesn't refire on mode-only mutations.
$effect(() => {
  const token = applyToken;
  if (token === 0) return;
  untrack(() => {
    if (applyMode && applyMode !== mode) {
      if (applyMode === "structured") structured = parseQuery(freeText);
      else freeText = safeCompose(structured);
      mode = applyMode;
    }
  });
});

function setMode(next: Mode) {
  if (next === mode) return;
  if (next === "structured") {
    // Re-parse the free-text value into the structured slot so the user
    // sees a populated form.
    structured = parseQuery(freeText);
  } else {
    // Compose the structured slot back into a single string.
    const composed = safeCompose(structured);
    freeText = composed;
    if (composed !== q) onChange(composed);
  }
  mode = next;
}

function onFreeInput(value: string) {
  freeText = value;
  if (debounceHandle) clearTimeout(debounceHandle);
  debounceHandle = setTimeout(() => onChange(value), Q_DEBOUNCE_MS);
}

function onStructuredField(field: keyof StructuredQuery, value: string) {
  structured = { ...structured, [field]: value };
}

function onStructuredSubmit() {
  if (debounceHandle) clearTimeout(debounceHandle);
  const composed = safeCompose(structured);
  if (composed !== q) onChange(composed);
}

function safeCompose(s: StructuredQuery): string {
  try {
    return composeQuery(s);
  } catch {
    // Length cap exceeded; trim the freeText component until it fits.
    const trimmed = { ...s, freeText: s.freeText.slice(0, Q_TOTAL_MAX / 2) };
    try {
      return composeQuery(trimmed);
    } catch {
      return q;
    }
  }
}

function openSavePrompt() {
  if (q.trim().length === 0) return;
  savePromptOpen = true;
  savePromptLabel = "";
  queueMicrotask(() => savePromptInputEl?.focus());
}

function commitSave() {
  const label = savePromptLabel.trim();
  if (label.length === 0 || q.trim().length === 0) return;
  onSaveSearch?.(label, q, mode);
  savePromptOpen = false;
  savePromptLabel = "";
}

function cancelSave() {
  savePromptOpen = false;
  savePromptLabel = "";
}

/**
 * Only cancel when focus leaves the entire `.save-prompt` cluster — clicking
 * the Save button blurs the input but the click should still commit.
 */
function onSavePromptBlur(e: FocusEvent) {
  const next = e.relatedTarget as Node | null;
  const container = (e.currentTarget as HTMLElement).parentElement;
  if (next && container?.contains(next)) return;
  cancelSave();
}

function onTabKeydown(e: KeyboardEvent, target: Mode) {
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    e.preventDefault();
    const next: Mode = mode === "free" ? "structured" : "free";
    setMode(next);
    return;
  }
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    setMode(target);
  }
}

function onSavePromptKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    commitSave();
  } else if (e.key === "Escape") {
    e.preventDefault();
    cancelSave();
  }
}

const showRecentRow = $derived(savedSearches.length > 0 || q.trim().length > 0);
const saveDisabled = $derived(q.trim().length === 0);
</script>

<section class="searchbar" aria-label="Search">
  <div class="tabs" role="tablist" aria-label="Search mode">
    <button
      type="button"
      role="tab"
      id="search-tab-free"
      aria-selected={mode === "free"}
      aria-controls="search-panel-free"
      tabindex={mode === "free" ? 0 : -1}
      class="tab"
      class:is-active={mode === "free"}
      onclick={() => setMode("free")}
      onkeydown={(e) => onTabKeydown(e, "free")}
    >Free text</button>
    <button
      type="button"
      role="tab"
      id="search-tab-structured"
      aria-selected={mode === "structured"}
      aria-controls="search-panel-structured"
      tabindex={mode === "structured" ? 0 : -1}
      class="tab"
      class:is-active={mode === "structured"}
      onclick={() => setMode("structured")}
      onkeydown={(e) => onTabKeydown(e, "structured")}
    >Structured</button>
  </div>

  {#if mode === "free"}
    <div
      role="tabpanel"
      id="search-panel-free"
      aria-labelledby="search-tab-free"
      class="mode-panel"
    >
      <label class="free-label">
        <span class="visually-hidden">Search roles</span>
        <input
          type="search"
          aria-label="Search roles"
          placeholder={placeholder}
          maxlength={Q_TOTAL_MAX}
          value={freeText}
          oninput={(e) => onFreeInput((e.currentTarget as HTMLInputElement).value)}
        />
      </label>
    </div>
  {:else}
    <div
      role="tabpanel"
      id="search-panel-structured"
      aria-labelledby="search-tab-structured"
      class="mode-panel"
    >
      <form
        class="structured-grid"
        onsubmit={(e) => { e.preventDefault(); onStructuredSubmit(); }}
      >
        <label class="field">
          <span class="field-label">Title</span>
          <input
            type="search"
            maxlength={Q_FIELD_MAX}
            value={structured.title}
            oninput={(e) => onStructuredField("title", (e.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <label class="field">
          <span class="field-label">Company</span>
          <input
            type="search"
            maxlength={Q_FIELD_MAX}
            value={structured.company}
            oninput={(e) => onStructuredField("company", (e.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <label class="field">
          <span class="field-label">Location</span>
          <input
            type="search"
            maxlength={Q_FIELD_MAX}
            value={structured.location}
            oninput={(e) => onStructuredField("location", (e.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <button type="submit" class="search-submit">Search</button>
      </form>
      {#if structuredFooter}
        <p class="structured-footer">{structuredFooter}</p>
      {/if}
    </div>
  {/if}

  {#if showRecentRow}
    <div class="recent-row">
      <span class="recent-label">Recent</span>
      <ul class="recent-pills" role="list">
        {#each savedSearches as s (s.id)}
          <li>
            <button
              type="button"
              class="recent-pill"
              aria-label={`Apply saved search: ${s.label}`}
              onclick={() => onApplySavedSearch?.(s.id)}
            >{s.label}</button>
          </li>
        {/each}
        <li>
          {#if savePromptOpen}
            <span class="save-prompt">
              <span class="visually-hidden">
                <label for="save-prompt-input">Saved-search label</label>
              </span>
              <input
                id="save-prompt-input"
                type="text"
                maxlength={SAVED_SEARCH_LABEL_MAX}
                placeholder="Label this search…"
                value={savePromptLabel}
                oninput={(e) => { savePromptLabel = (e.currentTarget as HTMLInputElement).value; }}
                onkeydown={onSavePromptKeydown}
                onblur={(e) => onSavePromptBlur(e)}
                bind:this={savePromptInputEl}
              />
              <button
                type="button"
                class="save-commit"
                onmousedown={(e) => e.preventDefault()}
                onclick={commitSave}
              >Save</button>
            </span>
          {:else}
            <button
              type="button"
              class="save-trigger"
              aria-disabled={saveDisabled}
              disabled={saveDisabled}
              onclick={openSavePrompt}
            >+ Save current</button>
          {/if}
        </li>
      </ul>
    </div>
  {/if}
</section>

<style>
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

  .searchbar {
    display: grid;
    gap: var(--space-2);
  }

  .tabs {
    display: flex;
    gap: 0;
    border-bottom: var(--rule-2) solid var(--color-ink);
  }
  .tab {
    appearance: none;
    background: transparent;
    border: 0;
    border-bottom: var(--rule-4) solid transparent;
    border-radius: 0;
    margin-bottom: calc(var(--rule-4) * -1);
    padding: var(--space-3) var(--space-4);
    min-height: var(--tap);
    color: var(--color-ink-3);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    cursor: pointer;
    transition: color 120ms ease-out, border-color 120ms ease-out;
  }
  .tab:hover:not(:disabled) {
    background: transparent;
    color: var(--color-ink);
  }
  .tab.is-active {
    background: transparent;
    color: var(--color-ink);
    border-bottom-color: var(--color-accent);
  }

  .mode-panel { padding-block: var(--space-3); }

  .free-label { display: block; }
  .free-label input {
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
  .free-label input::placeholder { color: var(--color-ink-3); }

  .structured-grid {
    display: grid;
    gap: var(--space-3);
    grid-template-columns: 1fr;
  }
  @media (min-width: 720px) {
    .structured-grid { grid-template-columns: 1fr 1fr 1fr auto; align-items: end; }
  }
  .field { display: grid; gap: var(--space-1); }
  .field-label {
    color: var(--color-ink-2);
    font-family: var(--font-mono);
    font-size: var(--text-00);
    letter-spacing: var(--track-wider);
    text-transform: uppercase;
  }
  .field input {
    width: 100%;
    min-height: var(--tap);
    padding: var(--space-2) var(--space-3);
    border: var(--rule-1) solid var(--color-ink);
    border-radius: 0;
    background: transparent;
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-2);
    font-weight: 600;
  }
  .search-submit {
    appearance: none;
    border: var(--rule-1) solid var(--color-accent);
    background: var(--color-accent);
    color: var(--color-on-accent);
    border-radius: 0;
    min-height: var(--tap);
    padding: 0 var(--space-4);
    font-family: var(--font-display);
    font-size: var(--text-2);
    font-weight: 800;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    cursor: pointer;
    transition: background-color 120ms ease-out, color 120ms ease-out;
  }
  .search-submit:hover { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-paper); }

  .structured-footer {
    margin: var(--space-2) 0 0;
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-size: var(--text-00);
    letter-spacing: var(--track-wider);
    text-transform: uppercase;
  }

  .recent-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    padding-block: var(--space-2);
    border-top: var(--rule-1) solid var(--color-rule-soft);
  }
  .recent-label {
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-size: var(--text-00);
    letter-spacing: var(--track-wider);
    text-transform: uppercase;
  }
  .recent-pills {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }
  .recent-pill {
    appearance: none;
    background: transparent;
    border: var(--rule-1) solid var(--color-rule-soft);
    border-radius: 0;
    padding: var(--space-1) var(--space-3);
    min-height: var(--tap);
    color: var(--color-ink-2);
    font-family: var(--font-mono);
    font-size: var(--text-1);
    cursor: pointer;
    transition: background-color 120ms ease-out, color 120ms ease-out, border-color 120ms ease-out;
  }
  .recent-pill:hover {
    background: var(--color-ink);
    border-color: var(--color-ink);
    color: var(--color-paper);
  }

  .save-trigger {
    appearance: none;
    background: transparent;
    border: var(--rule-1) dashed var(--color-ink-3);
    border-radius: 0;
    padding: var(--space-1) var(--space-3);
    min-height: var(--tap);
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-size: var(--text-1);
    cursor: pointer;
    transition: color 120ms ease-out, border-color 120ms ease-out;
  }
  .save-trigger:hover:not(:disabled) {
    color: var(--color-accent);
    border-color: var(--color-accent);
  }
  .save-trigger:disabled { opacity: 0.4; cursor: not-allowed; }

  .save-prompt {
    display: inline-flex;
    align-items: stretch;
    gap: var(--space-1);
  }
  .save-prompt input {
    min-height: var(--tap);
    padding: 0 var(--space-2);
    border: var(--rule-1) solid var(--color-ink);
    border-radius: 0;
    background: var(--color-paper);
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--text-1);
  }
  .save-commit {
    appearance: none;
    border: var(--rule-1) solid var(--color-accent);
    background: var(--color-accent);
    color: var(--color-on-accent);
    border-radius: 0;
    min-height: var(--tap);
    padding: 0 var(--space-3);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    cursor: pointer;
  }
  .save-commit:hover { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-paper); }
</style>
