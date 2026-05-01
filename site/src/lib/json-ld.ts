/**
 * Serialize a JSON-LD object for safe embedding inside an HTML
 * `<script type="application/ld+json">` element.
 *
 * `JSON.stringify` does not escape `<`, `>`, `&`, U+2028 or U+2029 - all
 * of which can either break out of the script context (`</script>`) or
 * smuggle JS-engine-significant whitespace into the parsed value. The
 * standard mitigation for inline structured-data scripts is to replace
 * those characters with their `\uXXXX` escape forms, which remain valid
 * JSON for any consumer that re-parses the body.
 *
 * See https://html.spec.whatwg.org/multipage/scripting.html#restrictions-for-contents-of-script-elements
 */

// `new RegExp(...)` with a string source keeps the file ASCII-clean — a
// literal U+2028 inside a regex literal terminates the line and breaks
// the JS parser.
const HTML_SCRIPT_HOSTILE_CHARS_RE = /[<>&\u2028\u2029]/g;

export function jsonLdSafe(payload: unknown): string {
  return JSON.stringify(payload).replace(
    HTML_SCRIPT_HOSTILE_CHARS_RE,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
