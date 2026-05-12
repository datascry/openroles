import type { HttpClient } from "../http.ts";
import { assertWorkdayHost } from "./common.ts";
import { parseWorkdaySite } from "./workday-site.ts";

// 8s ceiling on a single robots.txt fetch. The discovery call runs once
// per live tenant during the weekly reprobe pass; the operation as a
// whole must stay budget-friendly even when a CDN edge times out.
const FETCH_TIMEOUT_MS = 8_000;

/**
 * Fetch a Workday tenant's `/robots.txt` and extract the site label
 * required to address the cxs JSON API. The Workday root URL is
 * gated by an anti-bot CDN (HTTP 406 to scrapers), but `/robots.txt`
 * is publicly served and contains the label in the first
 * `Allow:` directive (and as a fallback in the `Sitemap:` URL).
 *
 * Returns null on any failure — network error, non-2xx response,
 * malformed body, missing label. Callers treat null as "no
 * discoverable site label" and either fall back to the hardcoded
 * probe list or leave `metadata.site` unset for the next reprobe.
 */
export async function fetchWorkdaySite(host: string, http: HttpClient): Promise<string | null> {
  try {
    assertWorkdayHost(host);
  } catch {
    return null;
  }
  const url = `https://${host}/robots.txt`;
  try {
    // skipRobots: the URL we are fetching IS robots.txt — reading
    // robots.txt to decide whether to read robots.txt is a deadlock.
    const res = await http.request(url, {
      method: "GET",
      skipRobots: true,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = await res.text();
    return parseWorkdaySite(body);
  } catch {
    return null;
  }
}
