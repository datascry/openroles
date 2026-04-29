/**
 * Helpers for rendering user-controlled state into chip labels.
 *
 * The active-filter strip echoes the user's search query back to the user as
 * a removable chip; the value is round-tripped through the URL so it must be
 * treated as untrusted. We strip control characters and truncate to a safe
 * display length so a hostile or pathological query can't break the strip's
 * layout or screen-reader announcement.
 */

const MAX_DISPLAY_LENGTH = 32;

/**
 * Sanitize an arbitrary user query for display inside a chip.
 *
 * - Strips ASCII control characters (`\x00-\x1F`, `\x7F`).
 * - Strips Unicode bidirectional override / format characters that can flip
 *   the rendered direction of surrounding text in screen readers and
 *   address bars.
 * - Collapses runs of whitespace to a single space.
 * - Trims leading/trailing whitespace.
 * - Truncates at `MAX_DISPLAY_LENGTH` characters, suffixing `…` when
 *   truncated.
 *
 * The result is always a string of printable, single-line, length-bounded
 * characters. Round-tripping the same input twice produces the same output.
 */
export function sanitizeChipLabel(raw: string): string {
  const stripped = raw
    // Collapse whitespace runs first so `\t` and `\n` survive as a single
    // space (the control-char strip below would otherwise eat them).
    .replace(/\s+/g, " ")
    // ASCII control chars and DEL (after whitespace collapse so the
    // remaining \x09/\x0A/\x0D are already converted). The control-char
    // class IS the point of this regex — stripping these chars is the
    // function's contract — so the lint rule that flags control chars in
    // regex literals is an over-eager false positive here.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping is the contract
    .replace(/[\x00-\x1F\x7F]/g, "")
    // Bidi overrides + zero-width chars + invisible separators.
    // U+200B-200F, U+202A-202E, U+2066-2069, U+FEFF.
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, "")
    .trim();
  if (stripped.length <= MAX_DISPLAY_LENGTH) return stripped;
  return `${stripped.slice(0, MAX_DISPLAY_LENGTH - 1)}…`;
}
