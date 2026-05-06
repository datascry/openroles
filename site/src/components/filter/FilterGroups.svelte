<script lang="ts">
import { onMount } from "svelte";
import type { FilterState } from "../../lib/filter-state.ts";
import { loadGroupExpansion, saveGroupExpansion } from "../../lib/group-storage.ts";
import AtsGroup from "./AtsGroup.svelte";
import LevelGroup from "./LevelGroup.svelte";
import MinCompGroup from "./MinCompGroup.svelte";
import PersonalToggles from "./PersonalToggles.svelte";
import PostedGroup from "./PostedGroup.svelte";
import StatusToggles from "./StatusToggles.svelte";
import WorkplaceGroup from "./WorkplaceGroup.svelte";

/**
 * Renders every filter group in vertical sequence. Used by both the desktop
 * sidebar and the mobile sheet — the chrome differs (collapsible vs always-
 * open headers) but the group sequence is identical.
 */
interface Props {
  filters: FilterState;
  onPatch: (patch: Partial<FilterState>) => void;
  savedCount: number;
  appliedCount: number;
  ignoredCount: number;
  optionCounts?: {
    ats: Record<string, number>;
    level: Record<string, number>;
    wt: Record<string, number>;
  };
  /** Whether each group title doubles as a collapse toggle (mobile only). */
  collapsible?: boolean;
}

let {
  filters,
  onPatch,
  savedCount,
  appliedCount,
  ignoredCount,
  optionCounts,
  collapsible = false,
}: Props = $props();

const GROUP_IDS = ["ats", "level", "wt", "posted", "minComp", "status", "personal"] as const;
type GroupId = (typeof GROUP_IDS)[number];

// Default policy: only the two heaviest facets (ATS + Level) start open.
// The rest collapse so the sidebar fits in a typical viewport without an
// internal scrollbar. Per-user expansion preferences are restored from
// localStorage onMount; first-visit users see this default.
let expansion = $state<Record<GroupId, boolean>>({
  ats: true,
  level: true,
  wt: false,
  posted: false,
  minComp: false,
  status: false,
  personal: false,
});

// Hydrate persisted expansion state once on mount. A reactive $effect would
// loop because the body reads and writes `expansion`.
onMount(() => {
  if (!collapsible) return;
  if (typeof window === "undefined") return;
  const next = { ...expansion };
  for (const id of GROUP_IDS) {
    const stored = loadGroupExpansion(window.localStorage, id);
    if (stored !== undefined) next[id] = stored;
  }
  expansion = next;
});

function setExpansion(id: GroupId, value: boolean) {
  expansion = { ...expansion, [id]: value };
  if (collapsible && typeof window !== "undefined") {
    saveGroupExpansion(window.localStorage, id, value);
  }
}
</script>

<div class="groups">
  <AtsGroup
    filters={filters}
    onPatch={onPatch}
    counts={optionCounts?.ats}
    collapsible={collapsible}
    expanded={expansion.ats}
    onExpandToggle={(v) => setExpansion("ats", v)}
  />
  <LevelGroup
    filters={filters}
    onPatch={onPatch}
    counts={optionCounts?.level}
    collapsible={collapsible}
    expanded={expansion.level}
    onExpandToggle={(v) => setExpansion("level", v)}
  />
  <WorkplaceGroup
    filters={filters}
    onPatch={onPatch}
    counts={optionCounts?.wt}
    collapsible={collapsible}
    expanded={expansion.wt}
    onExpandToggle={(v) => setExpansion("wt", v)}
  />
  <PostedGroup
    filters={filters}
    onPatch={onPatch}
    collapsible={collapsible}
    expanded={expansion.posted}
    onExpandToggle={(v) => setExpansion("posted", v)}
  />
  <MinCompGroup
    filters={filters}
    onPatch={onPatch}
    collapsible={collapsible}
    expanded={expansion.minComp}
    onExpandToggle={(v) => setExpansion("minComp", v)}
  />
  <StatusToggles
    filters={filters}
    onPatch={onPatch}
    collapsible={collapsible}
    expanded={expansion.status}
    onExpandToggle={(v) => setExpansion("status", v)}
  />
  <PersonalToggles
    filters={filters}
    onPatch={onPatch}
    savedCount={savedCount}
    appliedCount={appliedCount}
    ignoredCount={ignoredCount}
    collapsible={collapsible}
    expanded={expansion.personal}
    onExpandToggle={(v) => setExpansion("personal", v)}
  />
</div>

<style>
  .groups {
    display: grid;
    gap: var(--space-4);
  }
</style>
