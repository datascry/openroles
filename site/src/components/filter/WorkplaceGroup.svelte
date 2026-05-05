<script lang="ts">
import { WORKPLACE_TYPES, type WorkplaceType } from "@openroles/shared/constants";
import type { FilterState } from "../../lib/filter-state.ts";
import ChipList from "./ChipList.svelte";
import GroupCard from "./GroupCard.svelte";

interface Props {
  filters: Pick<FilterState, "wt">;
  onPatch: (patch: Partial<FilterState>) => void;
  counts?: Record<string, number>;
  collapsible?: boolean;
  expanded?: boolean;
  onExpandToggle?: (expanded: boolean) => void;
}

let { filters, onPatch, counts, collapsible, expanded, onExpandToggle }: Props = $props();

const options = $derived(
  WORKPLACE_TYPES.map((id) => {
    const count = counts?.[id];
    const effective = count ?? 0;
    return {
      id,
      label: id,
      count,
      disabled: counts !== undefined && effective === 0 && !filters.wt.includes(id),
    };
  }),
);

function toggle(id: string) {
  const wt = filters.wt as ReadonlyArray<NonNullable<WorkplaceType>>;
  const next = wt.includes(id as NonNullable<WorkplaceType>)
    ? wt.filter((x) => x !== id)
    : [...wt, id as NonNullable<WorkplaceType>];
  onPatch({ wt: next });
}
</script>

<GroupCard
  id="wt"
  title={`Workplace · ${filters.wt.length}/${WORKPLACE_TYPES.length}`}
  count={filters.wt.length}
  {collapsible}
  {expanded}
  {onExpandToggle}
>
  <ChipList
    groupId="wt"
    options={options}
    selected={filters.wt}
    onToggle={toggle}
  />
</GroupCard>
