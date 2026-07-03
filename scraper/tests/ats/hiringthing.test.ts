import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { TenantInput } from "@openroles/shared";
import fc from "fast-check";
import { parseHiringthingFeed, scrapeHiringthingTenant } from "../../src/ats/hiringthing.ts";
import { HttpClient } from "../../src/http.ts";
import { RobotsTxtCache } from "../../src/robots.ts";
import {
  clientWithRobotsAllowAll,
  HttpResponse,
  http,
  makeServer,
  readFixtureText,
} from "../helpers.ts";

const OBSERVED_AT = "2026-07-03T00:00:00Z";
const SLUG = "pinnacle";
const FEED_URL = `https://${SLUG}.hiringthing.com/api/rss.xml`;
const FEED = readFixtureText("hiringthing.feed.xml");
const EMPTY = readFixtureText("hiringthing.empty.xml");
const EDGE = readFixtureText("hiringthing.edge.xml");

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function parse(xml: string, tenant: TenantInput = { slug: SLUG, display_name: "Pinnacle" }) {
  return parseHiringthingFeed({
    tenant,
    company: tenant.display_name ?? tenant.slug,
    xml,
    observedAt: OBSERVED_AT,
  });
}

function run(tenant: TenantInput): ReturnType<typeof scrapeHiringthingTenant> {
  return scrapeHiringthingTenant({
    tenant,
    client: clientWithRobotsAllowAll(),
    observedAt: OBSERVED_AT,
  });
}

describe("parseHiringthingFeed (fixture replay)", () => {
  it("parses the board feed into validated, deep-linked Jobs", () => {
    const jobs = parse(FEED);
    expect(jobs).toHaveLength(3);
    const builder = jobs.find((j) => j.title.startsWith("Builder/Maker/Cabinet Maker"));
    // source_id is the numeric job id carried in the /job/{id}/{title-slug} link.
    expect(builder?.source_id).toBe("972978");
    expect(builder?.url).toBe(
      `https://${SLUG}.hiringthing.com/job/972978/builder-maker-cabinet-maker-exhibits-events-raleigh-durham-nc`,
    );
    expect(builder?.company).toBe("Pinnacle");
    expect(builder?.ats).toBe("hiringthing");
    expect(builder?.location_text).toBe("Durham, NC");
    expect(builder?.location_region).toBe("NC");
    // The HTML media:description CDATA flows through the excerpt path.
    expect(builder?.description_excerpt && builder.description_excerpt.length > 0).toBe(true);
    // The feed carries no pubDate — posted_at must be absent.
    expect(builder?.posted_at).toBeUndefined();

    const account = jobs.find((j) => j.source_id === "1033869");
    expect(account?.title).toBe("Account Manager, Raleigh | Events, Exhibits");
    expect(account?.location_text).toBe("Raleigh, NC");

    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
  });

  it("returns no jobs for a live board with an empty channel", () => {
    expect(parse(EMPTY)).toHaveLength(0);
  });

  it("handles edge items: CDATA titles, missing location, id-less/malformed skipped, dupes, off-host links", () => {
    const jobs = parse(EDGE, { slug: "edgeco", display_name: "Edge Co" });
    // 7 items in the fixture:
    //  - 111001: CDATA title with entities -> kept
    //  - 111002: no <location> element -> kept, location omitted
    //  - id-less link (/careers, no /job/{id}/) -> skipped
    //  - duplicate of 111001 (same id + link) -> deduped
    //  - bare-text item (not an element map) -> skipped
    //  - 111003: off-host link -> kept, URL composed on the tenant host
    //  - 111004: relative (unparseable) link -> kept, URL composed
    expect(jobs).toHaveLength(4);

    const rnd = jobs.find((j) => j.source_id === "111001");
    expect(rnd?.title).toBe("R&D Engineer & Fabricator");
    expect(rnd?.location_text).toBe("Portland, OR");
    // CDATA HTML flows through the house plainText/excerpt path, which
    // emits each decoded entity as its own space-joined text node
    // (`R&amp;D` → `R & D`) — the entity content survives, spaced.
    expect(rnd?.description_excerpt).toContain("R & D team builds < great > things & more");

    const remote = jobs.find((j) => j.source_id === "111002");
    // Entity in a plain (non-CDATA) title is decoded by the XML parser.
    expect(remote?.title).toBe("Remote Support Specialist & Trainer");
    expect(remote?.location_text).toBeUndefined();
    expect(remote?.workplace_type).toBe("remote"); // inferred from the title hint

    const offHost = jobs.find((j) => j.source_id === "111003");
    expect(offHost?.title).toBe("Off-Host Link Role");
    expect(offHost?.url).toBe("https://edgeco.hiringthing.com/job/111003");

    const relative = jobs.find((j) => j.source_id === "111004");
    expect(relative?.title).toBe("Relative Link Role");
    expect(relative?.url).toBe("https://edgeco.hiringthing.com/job/111004");

    expect(jobs.some((j) => j.title === "Id-less Link Role")).toBe(false);
    expect(jobs.some((j) => j.title === "Duplicate Of First")).toBe(false);
  });

  it("returns [] on malformed XML, non-RSS, and channel-less documents — never throws", () => {
    for (const xml of [
      "not xml at all",
      "<?xml version='1.0'?><other/>",
      "<rss><channel></channel></rss>",
      "<rss version='2.0'/>",
      "",
    ]) {
      expect(parse(xml)).toEqual([]);
    }
  });

  it("accepts a single-item channel (object, not array)", () => {
    const xml =
      "<rss version='2.0'><channel><title>One</title>" +
      "<item><title>Only Role</title><link>https://one.hiringthing.com/job/42/only-role</link>" +
      "<location>NYC, NY</location></item></channel></rss>";
    const jobs = parse(xml, { slug: "one" });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.source_id).toBe("42");
  });
});

describe("parseHiringthingFeed (property)", () => {
  const safeSlug = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/);

  it("is deterministic on the same feed for any safe slug", () => {
    fc.assert(
      fc.property(safeSlug, (slug) => {
        const a = parse(FEED, { slug });
        const b = parse(FEED, { slug });
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 40 },
    );
  });

  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), (xml) => {
        parse(xml, { slug: "x" });
        return true;
      }),
      { numRuns: 60 },
    );
  });
});

describe("scrapeHiringthingTenant", () => {
  it("fetches the feed and assembles jobs", async () => {
    server.use(http.get(FEED_URL, () => HttpResponse.xml(FEED)));
    const out = await run({ slug: SLUG, display_name: "Pinnacle" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(3);
    expect(out.result.http_status).toBe(200);
    expect(out.jobs.every((j) => j.url.includes(`${SLUG}.hiringthing.com/job/`))).toBe(true);
  });

  it("returns success with zero jobs for a live board with an empty channel", async () => {
    server.use(http.get(FEED_URL, () => HttpResponse.xml(EMPTY)));
    const out = await run({ slug: SLUG });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(0);
  });

  it("retries on 5xx then succeeds", async () => {
    let n = 0;
    server.use(
      http.get(FEED_URL, () => {
        n += 1;
        return n < 2 ? new HttpResponse("err", { status: 503 }) : HttpResponse.xml(FEED);
      }),
    );
    const out = await run({ slug: SLUG });
    expect(n).toBe(2);
    expect(out.result.status).toBe("success");
  });

  it("marks dead on 404 and transient on exhausted 5xx", async () => {
    server.use(http.get(FEED_URL, () => new HttpResponse("no", { status: 404 })));
    expect((await run({ slug: SLUG })).result.status).toBe("dead");
    server.resetHandlers();
    server.use(http.get(FEED_URL, () => new HttpResponse("err", { status: 502 })));
    expect((await run({ slug: SLUG })).result.status).toBe("transient_failure");
  });

  it("blocks on robots.txt Disallow: /", async () => {
    const robotsFetch = mock(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/robots.txt"))
        return new Response("User-agent: *\nDisallow: /\n", { status: 200 });
      throw new Error(`unexpected ${url}`);
    });
    const client = new HttpClient({
      userAgent: "openroles/0.0.0 (+https://example.com)",
      robots: new RobotsTxtCache({ fetchFn: robotsFetch, clock: () => 0 }),
      sleep: async () => {},
      random: () => 0.5,
      retry: { maxAttempts: 1, baseMs: 1, maxMs: 1 },
    });
    const out = await scrapeHiringthingTenant({
      tenant: { slug: SLUG },
      client,
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("robots.txt");
  });

  it("marks the tenant dead on an unsafe slug", async () => {
    const out = await run({ slug: "Bad_Slug" });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("tenant slug rejected");
  });
});
