<script lang="ts">
import { LEVELS, type Level } from "@openroles/shared/constants";
import type { FilterState } from "../../lib/filter-state.ts";
import ChipList from "./ChipList.svelte";
import GroupCard from "./GroupCard.svelte";

interface Props {
  filters: Pick<FilterState, "level">;
  onPatch: (patch: Partial<FilterState>) => void;
  counts?: Record<string, number>;
  collapsible?: boolean;
  expanded?: boolean;
  onExpandToggle?: (expanded: boolean) => void;
}

let { filters, onPatch, counts, collapsible, expanded, onExpandToggle }: Props = $props();

const NON_NULL_LEVELS = LEVELS.filter((l): l is NonNullable<Level> => l !== null);
const options = $derived(
  NON_NULL_LEVELS.map((id) => {
    const count = counts?.[id];
    const effective = count ?? 0;
    return {
      id,
      label: id,
      count,
      disabled: counts !== undefined && effective === 0 && !filters.level.includes(id),
    };
  }),
);

function toggle(id: string) {
  const level = filters.level as ReadonlyArray<NonNullable<Level>>;
  const next = level.includes(id as NonNullable<Level>)
    ? level.filter((x) => x !== id)
    : [...level, id as NonNullable<Level>];
  onPatch({ level: next });
}
</script>

<GroupCard
  id="level"
  title={`Level · ${filters.level.length}/${NON_NULL_LEVELS.length}`}
  count={filters.level.length}
  {collapsible}
  {expanded}
  {onExpandToggle}
>
  <ChipList
    groupId="level"
    options={options}
    selected={filters.level}
    onToggle={toggle}
  />
</GroupCard>
