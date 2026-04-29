/**
 * Pure helpers for the numbered pager. Hoisted out of the FilterTable Svelte
 * island so the invariants are testable in isolation.
 *
 * The functions are pure, side-effect-free, and bounded — every output is
 * derivable from the inputs alone.
 */

export type PageToken = number | "ellipsis";

/**
 * Returns the ordered list of page tokens to render in the numbered pager.
 *
 * Invariants:
 *  - Every numeric token is in `[1, total]`.
 *  - Numeric tokens appear in strictly increasing order.
 *  - `1` and `total` are always present (when `total >= 1`).
 *  - An `"ellipsis"` token only appears between two numeric tokens whose
 *    distance is greater than 1.
 *  - Two `"ellipsis"` tokens never appear adjacent to each other.
 *  - When `total <= 7` the result is the full sequence `[1..total]`.
 *
 * @throws Error if `total < 1` or `current` is outside `[1, total]`.
 */
export function pagesToShow(current: number, total: number): ReadonlyArray<PageToken> {
  if (!Number.isInteger(total) || total < 1) {
    throw new Error(`pagesToShow: total must be a positive integer, got ${total}`);
  }
  if (!Number.isInteger(current) || current < 1 || current > total) {
    throw new Error(`pagesToShow: current must be in [1, ${total}], got ${current}`);
  }
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  // The window always contains 1 and total. Around current we keep ±1.
  // When expanding the head (current ≤ 3) we also pin total-1 so the
  // tail boundary stays a pair (…, 19, 20). Symmetric for the tail.
  const window = new Set<number>([1, total, current, current - 1, current + 1]);
  if (current <= 3) {
    window
      .add(2)
      .add(3)
      .add(4)
      .add(total - 1);
  }
  if (current >= total - 2) {
    window
      .add(total - 1)
      .add(total - 2)
      .add(total - 3)
      .add(2);
  }
  const sorted = [...window].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  const out: PageToken[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i] as number;
    out.push(n);
    const next = sorted[i + 1];
    if (next !== undefined && next - n > 1) out.push("ellipsis");
  }
  return out;
}
