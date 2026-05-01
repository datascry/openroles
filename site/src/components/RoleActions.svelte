<script lang="ts">
import { onMount } from "svelte";
import {
  loadApplied,
  loadIgnored,
  loadSaved,
  markApplied,
  toggleIgnored,
  toggleSaved,
  unmarkApplied,
} from "../lib/storage.ts";

// Slim island. The apply CTA lives in the static HTML on the role page
// (so it works without JS); this component only handles the localStorage
// save/apply/ignore toggles. See specs/role-detail.md.

interface Props {
  id: string;
}

const { id }: Props = $props();

let saved = $state(false);
let applied = $state(false);
let ignored = $state(false);

function refresh(): void {
  if (typeof window === "undefined") return;
  saved = loadSaved(window.localStorage).ids.includes(id);
  applied = loadApplied(window.localStorage).entries.some((e) => e.id === id);
  ignored = loadIgnored(window.localStorage).ids.includes(id);
}

onMount(refresh);

function onSave(): void {
  toggleSaved(window.localStorage, id);
  refresh();
}

function onApply(): void {
  if (applied) {
    unmarkApplied(window.localStorage, id);
  } else {
    markApplied(window.localStorage, id, new Date().toISOString());
  }
  refresh();
}

function onIgnore(): void {
  toggleIgnored(window.localStorage, id);
  refresh();
}
</script>

<div class="role-actions">
  <button type="button" onclick={onSave} aria-pressed={saved}>
    {saved ? "★ Saved" : "☆ Save"}
  </button>
  <button type="button" onclick={onApply} aria-pressed={applied}>
    {applied ? "✓ Applied" : "Mark applied"}
  </button>
  <button type="button" onclick={onIgnore} aria-pressed={ignored}>
    {ignored ? "⊘ Ignored" : "Ignore"}
  </button>
</div>

<style>
  .role-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }
  .role-actions button {
    cursor: pointer;
  }
</style>
