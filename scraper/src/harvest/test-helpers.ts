// Tiny helpers shared across the harvest / probe / cli tests.
//
// The url-host check in particular replaces the old `url.includes("host")`
// pattern that CodeQL flags as `js/incomplete-url-substring-sanitization`:
// `attacker.com/?u=https://example.com/x` would match `includes("example.com")`
// even though the URL points at `attacker.com`. In test code the URLs are
// fixtures we control, so this is theoretical, but the safer pattern also
// makes the test intent clearer (we want to dispatch on hostname, not on
// raw substring) and silences the alert tray.

/**
 * Return `true` when `url` parses to a hostname that exactly matches
 * `host` or is a sub-domain of it. Returns `false` for malformed URLs
 * rather than throwing — test-side mocks see all kinds of inputs and a
 * crash mid-mock is worse than a missed match.
 */
export function urlHostMatches(url: string, host: string): boolean {
  let h: string;
  try {
    h = new URL(url).hostname;
  } catch {
    return false;
  }
  return h === host || h.endsWith(`.${host}`);
}

/** Strict version: exact hostname match only, no sub-domains. */
export function urlHostIs(url: string, host: string): boolean {
  try {
    return new URL(url).hostname === host;
  } catch {
    return false;
  }
}
