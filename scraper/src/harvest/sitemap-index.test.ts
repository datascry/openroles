import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Tenant } from "@openroles/shared";
import fc from "fast-check";
import {
  extractSlugFromLoc,
  fetchSitemapSlugs,
  mergeSitemapSlugs,
  parseSitemapIndex,
  SITEMAP_SOURCES,
  sitemapSourceFor,
} from "./sitemap-index.ts";

const FIX = join(import.meta.dir, "fixtures", "sitemap");
const readFix = (name: string): string => readFileSync(join(FIX, name), "utf8");

const ISOLVED_INDEX = readFix("isolvedhire-index.xml");
const JAZZ_FEED = readFix("jazzhr-feed.xml");
const HIRINGTHING_INDEX = readFix("hiringthing-index.xml");
const HIRINGTHING_CHILD = readFix("hiringthing-child.xml");

describe("parseSitemapIndex", () => {
  it("extracts every <loc> from a <sitemapindex>", () => {
    const locs = parseSitemapIndex(ISOLVED_INDEX);
    expect(locs).toContain("https://davidsonoil.isolvedhire.com/job_site_map.xml");
    expect(locs).toContain("https://isolved.isolvedhire.com/job_site_map.xml");
    expect(locs.length).toBe(6);
  });

  it("extracts every <loc> from a <urlset>", () => {
    const locs = parseSitemapIndex(JAZZ_FEED);
    expect(locs.some((u) => u.startsWith("https://easeinc.applytojob.com/"))).toBe(true);
    expect(locs.some((u) => u.startsWith("https://brennancenter.applytojob.com/"))).toBe(true);
  });

  it("extracts gzip child <loc>s from the hiringthing index", () => {
    const locs = parseSitemapIndex(HIRINGTHING_INDEX);
    expect(locs.length).toBe(3);
    expect(locs[0]).toContain("cid_00003634_sitemap.xml.gz");
  });

  it("trims whitespace inside <loc> and de-duplicates", () => {
    const xml = `<urlset><url><loc>  https://a.applytojob.com/x  </loc></url>
      <url><loc>https://a.applytojob.com/x</loc></url></urlset>`;
    expect(parseSitemapIndex(xml)).toEqual(["https://a.applytojob.com/x"]);
  });

  it("returns [] on malformed / empty / non-XML input instead of throwing", () => {
    expect(parseSitemapIndex("")).toEqual([]);
    expect(parseSitemapIndex("not xml at all")).toEqual([]);
    expect(parseSitemapIndex("<urlset><url><loc>unclosed")).toEqual([]);
    expect(parseSitemapIndex("<urlset></urlset>")).toEqual([]);
    // A <loc> whose content is only whitespace contributes nothing.
    expect(parseSitemapIndex("<urlset><url><loc>   </loc></url></urlset>")).toEqual([]);
  });

  it("is deterministic — same input yields the same output (fast-check)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^https:\/\/[a-z]{1,12}\.applytojob\.com\/[a-z]{1,8}$/), {
          maxLength: 20,
        }),
        (urls) => {
          const xml = `<urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;
          const a = parseSitemapIndex(xml);
          const b = parseSitemapIndex(xml);
          expect(a).toEqual(b);
          // Every emitted loc is one of the inputs (no fabrication) and
          // the result is de-duplicated.
          expect(new Set(a).size).toBe(a.length);
          for (const u of a) expect(urls).toContain(u);
        },
      ),
    );
  });
});

describe("parseSitemapIndex — ReDoS resilience", () => {
  it("returns [] quickly on a large unclosed-<loc> input (no catastrophic backtracking)", () => {
    // Regression: `/<loc>([\s\S]*?)<\/loc>/` is O(n²) on many `<loc>`
    // opens with no close — 200k opens hung ~85s. The bounded `[^<]{0,2048}`
    // class fails each attempt at the next `<`, so a ~1.2MB unclosed body
    // parses in milliseconds. Assert both correctness (empty) and that the
    // call returns essentially instantly.
    const evil = "<loc>".repeat(200_000); // ~1MB, zero closing tags
    const start = performance.now();
    const result = parseSitemapIndex(evil);
    const elapsedMs = performance.now() - start;
    expect(result).toEqual([]);
    expect(elapsedMs).toBeLessThan(500);
  });

  it("skips a single pathologically long <loc> body rather than emitting garbage", () => {
    // A loc longer than the 2048 bound simply does not match — it is not
    // truncated into a partial (wrong) URL.
    const longUrl = `https://x.applytojob.com/${"a".repeat(4000)}`;
    const xml = `<urlset><url><loc>${longUrl}</loc></url><url><loc>https://ok.applytojob.com/a</loc></url></urlset>`;
    const locs = parseSitemapIndex(xml);
    // The over-long loc is dropped; the normal one survives.
    expect(locs).toEqual(["https://ok.applytojob.com/a"]);
  });
});

describe("extractSlugFromLoc", () => {
  it("extracts the subdomain slug for isolvedhire", () => {
    expect(
      extractSlugFromLoc("isolvedhire", "https://davidsonoil.isolvedhire.com/job_site_map.xml"),
    ).toBe("davidsonoil");
  });

  it("extracts the subdomain slug for jazzhr", () => {
    expect(
      extractSlugFromLoc("jazzhr", "https://easeinc.applytojob.com/apply/vMHpWDZa3l/Account"),
    ).toBe("easeinc");
  });

  it("extracts the subdomain slug for hiringthing from a child <loc>", () => {
    expect(
      extractSlugFromLoc("hiringthing", "https://keplercannon.hiringthing.com/job/9160/consultant"),
    ).toBe("keplercannon");
  });

  it("returns null for a <loc> on the platform feed host (deny-listed)", () => {
    // feeds.isolvedhire.com is the sitemap host, not a tenant — the
    // connector deny list must exclude it so it never mints a slug.
    expect(
      extractSlugFromLoc("isolvedhire", "https://feeds.isolvedhire.com/site_map_index.xml"),
    ).toBeNull();
  });

  it("returns null for a <loc> that does not match the connector host", () => {
    expect(extractSlugFromLoc("isolvedhire", "https://example.com/whatever")).toBeNull();
    expect(
      extractSlugFromLoc("hiringthing", "https://s3.amazonaws.com/…/cid_00003634_sitemap.xml.gz"),
    ).toBeNull();
  });

  it("does not mint a slug from a confusable host that only prefixes the platform domain", () => {
    // `acme.applytojob.com.evil.com` is the attacker's host — the platform
    // domain is a mere substring, not the authority. The host-boundary
    // check must reject it so no `acme` slug leaks in.
    expect(extractSlugFromLoc("jazzhr", "https://acme.applytojob.com.evil.com/apply/x")).toBeNull();
    expect(
      extractSlugFromLoc("isolvedhire", "https://acme.isolvedhire.com.evil.com/job_site_map.xml"),
    ).toBeNull();
    // The legitimate forms still mint (boundary is `/`, `?`, `:`, or end).
    expect(extractSlugFromLoc("jazzhr", "https://acme.applytojob.com/apply/x")).toBe("acme");
    expect(extractSlugFromLoc("jazzhr", "https://acme.applytojob.com")).toBe("acme");
    expect(extractSlugFromLoc("jazzhr", "https://acme.applytojob.com?ref=1")).toBe("acme");
    expect(extractSlugFromLoc("jazzhr", "https://acme.applytojob.com:443/x")).toBe("acme");
  });
});

describe("SITEMAP_SOURCES / sitemapSourceFor", () => {
  it("resolves a configured source", () => {
    const s = sitemapSourceFor("isolvedhire");
    expect(s?.indexUrls[0]).toContain("feeds.isolvedhire.com");
    expect(s?.descend).toBe(false);
  });

  it("returns undefined for an ATS with no sitemap source", () => {
    expect(sitemapSourceFor("greenhouse")).toBeUndefined();
  });

  it("marks jazzhr as liveness-truth with five feed pages", () => {
    const s = SITEMAP_SOURCES.jazzhr;
    expect(s?.livenessTruth).toBe(true);
    expect(s?.indexUrls.length).toBe(5);
  });

  it("marks hiringthing as descend + gzip with a pinned child host", () => {
    const s = SITEMAP_SOURCES.hiringthing;
    expect(s?.descend).toBe(true);
    expect(s?.childIsGzip).toBe(true);
    // Descending sources must pin the child host so a poisoned index can't
    // redirect the sweep off-host (SSRF).
    expect(s?.childHostAllow).toBe("s3.amazonaws.com");
  });
});

describe("fetchSitemapSlugs", () => {
  it("extracts slugs from a non-descending index (isolvedhire) in one fetch", async () => {
    const calls: string[] = [];
    const fetchFn = async (url: string): Promise<Response> => {
      calls.push(url);
      return new Response(ISOLVED_INDEX, { status: 200 });
    };
    const res = await fetchSitemapSlugs({ ats: "isolvedhire", fetchFn });
    expect(calls.length).toBe(1);
    expect(res.slugs).toContain("davidsonoil");
    expect(res.slugs).toContain("isolved");
    // Deterministic sorted order, de-duplicated.
    expect([...res.slugs].sort()).toEqual(res.slugs);
  });

  it("fetches every feed page for a multi-page urlset source (jazzhr)", async () => {
    const calls: string[] = [];
    const fetchFn = async (url: string): Promise<Response> => {
      calls.push(url);
      return new Response(JAZZ_FEED, { status: 200 });
    };
    const res = await fetchSitemapSlugs({ ats: "jazzhr", fetchFn });
    expect(calls.length).toBe(5);
    expect(res.slugs).toContain("easeinc");
    expect(res.slugs).toContain("brennancenter");
  });

  it("descends into gzip children (hiringthing) up to maxChildren", async () => {
    const gz = gzipSync(Buffer.from(HIRINGTHING_CHILD));
    const calls: string[] = [];
    const fetchFn = async (url: string): Promise<Response> => {
      calls.push(url);
      if (url.endsWith(".xml.gz")) {
        return new Response(gz, { status: 200 });
      }
      return new Response(HIRINGTHING_INDEX, { status: 200 });
    };
    const res = await fetchSitemapSlugs({ ats: "hiringthing", fetchFn, maxChildren: 2 });
    // 1 index + 2 children (capped at maxChildren, not all 3).
    expect(calls.length).toBe(3);
    expect(res.truncated).toBe(true);
    expect(res.slugs).toContain("keplercannon");
  });

  it("does not truncate when maxChildren covers every child", async () => {
    const gz = gzipSync(Buffer.from(HIRINGTHING_CHILD));
    const fetchFn = async (url: string): Promise<Response> =>
      url.endsWith(".xml.gz")
        ? new Response(gz, { status: 200 })
        : new Response(HIRINGTHING_INDEX, { status: 200 });
    const res = await fetchSitemapSlugs({ ats: "hiringthing", fetchFn, maxChildren: 100 });
    expect(res.truncated).toBe(false);
  });

  it("drops a child that fails to fetch or gunzip, keeps the rest", async () => {
    const gz = gzipSync(Buffer.from(HIRINGTHING_CHILD));
    let n = 0;
    const fetchFn = async (url: string): Promise<Response> => {
      if (url.endsWith(".xml.gz")) {
        n += 1;
        if (n === 1) throw new Error("network");
        if (n === 2) return new Response(Buffer.from("not gzip"), { status: 200 });
        return new Response(gz, { status: 200 });
      }
      return new Response(HIRINGTHING_INDEX, { status: 200 });
    };
    const res = await fetchSitemapSlugs({ ats: "hiringthing", fetchFn, maxChildren: 3 });
    // Two children failed; the third still yields keplercannon.
    expect(res.slugs).toContain("keplercannon");
    expect(res.childrenFailed).toBe(2);
  });

  it("returns [] when the index fetch fails (non-2xx)", async () => {
    const fetchFn = async (): Promise<Response> => new Response("", { status: 500 });
    const res = await fetchSitemapSlugs({ ats: "isolvedhire", fetchFn });
    expect(res.slugs).toEqual([]);
  });

  it("returns [] when the index fetch throws", async () => {
    const fetchFn = async (): Promise<Response> => {
      throw new Error("boom");
    };
    const res = await fetchSitemapSlugs({ ats: "isolvedhire", fetchFn });
    expect(res.slugs).toEqual([]);
  });

  it("skips a child whose host is unsafe (SSRF guard)", async () => {
    // A malicious index pointing a child at a metadata IP must never be
    // fetched.
    const evilIndex = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>http://169.254.169.254/latest/meta-data/</loc></sitemap></sitemapindex>`;
    const calls: string[] = [];
    const fetchFn = async (url: string): Promise<Response> => {
      calls.push(url);
      if (url.includes("169.254")) return new Response("secret", { status: 200 });
      return new Response(evilIndex, { status: 200 });
    };
    const res = await fetchSitemapSlugs({ ats: "hiringthing", fetchFn });
    expect(calls.some((u) => u.includes("169.254"))).toBe(false);
    expect(res.slugs).toEqual([]);
  });

  it("does NOT fetch a child on a host outside the source's allow (SSRF)", async () => {
    // A poisoned index points a child at an arbitrary external host. Even
    // though it's a public, non-IP host that passes isSafeFetchHost, the
    // child-host allow (`s3.amazonaws.com`) must reject it before any fetch.
    const evilIndex = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://attacker.evil.com/cid_1_sitemap.xml.gz</loc></sitemap></sitemapindex>`;
    const fetched: string[] = [];
    const fetchFn = async (url: string): Promise<Response> => {
      fetched.push(url);
      if (url.includes("evil.com")) return new Response("pwned", { status: 200 });
      return new Response(evilIndex, { status: 200 });
    };
    const res = await fetchSitemapSlugs({ ats: "hiringthing", fetchFn });
    // The child on evil.com was never fetched.
    expect(fetched.some((u) => u.includes("evil.com"))).toBe(false);
    expect(res.slugs).toEqual([]);
    expect(res.childrenFailed).toBe(1);
  });

  it("allows a child on a subdomain of the pinned host", async () => {
    const gz = gzipSync(Buffer.from(HIRINGTHING_CHILD));
    // A child on a legitimate subdomain of s3.amazonaws.com is permitted.
    const subIndex = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://bucket.s3.amazonaws.com/cid_1_sitemap.xml.gz</loc></sitemap></sitemapindex>`;
    const fetched: string[] = [];
    const fetchFn = async (url: string): Promise<Response> => {
      fetched.push(url);
      if (url.endsWith(".xml.gz")) return new Response(gz, { status: 200 });
      return new Response(subIndex, { status: 200 });
    };
    const res = await fetchSitemapSlugs({ ats: "hiringthing", fetchFn });
    expect(fetched.some((u) => u.includes("bucket.s3.amazonaws.com"))).toBe(true);
    expect(res.slugs).toContain("keplercannon");
  });

  it("does not follow a child redirect that points off the allowed host", async () => {
    // The child host is allowed, but the response is a 302 whose Location
    // escapes the guard (internal metadata). With redirect:manual we see
    // the 3xx un-followed and drop it — we never fetch the Location.
    const fetched: Array<{ url: string; redirect?: string }> = [];
    const fetchFn = async (url: string, init?: { redirect?: "manual" }): Promise<Response> => {
      fetched.push({ url, redirect: init?.redirect });
      if (url.endsWith(".xml.gz")) {
        return new Response("", {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        });
      }
      return new Response(HIRINGTHING_INDEX, { status: 200 });
    };
    const res = await fetchSitemapSlugs({ ats: "hiringthing", fetchFn, maxChildren: 1 });
    // The child fetch used redirect:manual and the metadata IP was never hit.
    expect(fetched.some((f) => f.url.includes("169.254"))).toBe(false);
    expect(fetched.some((f) => f.url.endsWith(".xml.gz") && f.redirect === "manual")).toBe(true);
    expect(res.slugs).toEqual([]);
    expect(res.childrenFailed).toBe(1);
  });

  it("drops a child redirect with no Location header", async () => {
    const fetchFn = async (url: string): Promise<Response> => {
      if (url.endsWith(".xml.gz")) return new Response("", { status: 301 });
      return new Response(HIRINGTHING_INDEX, { status: 200 });
    };
    const res = await fetchSitemapSlugs({ ats: "hiringthing", fetchFn, maxChildren: 1 });
    expect(res.slugs).toEqual([]);
    expect(res.childrenFailed).toBe(1);
  });

  it("drops a child redirect whose Location is unparseable", async () => {
    const fetchFn = async (url: string): Promise<Response> => {
      if (url.endsWith(".xml.gz")) {
        return new Response("", { status: 302, headers: { location: "ht!tp://[bad]" } });
      }
      return new Response(HIRINGTHING_INDEX, { status: 200 });
    };
    const res = await fetchSitemapSlugs({ ats: "hiringthing", fetchFn, maxChildren: 1 });
    expect(res.slugs).toEqual([]);
    expect(res.childrenFailed).toBe(1);
  });

  it("skips a child whose <loc> is not a parseable URL", async () => {
    const badIndex = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>ht!tp://[not a url]/child.xml.gz</loc></sitemap></sitemapindex>`;
    const calls: string[] = [];
    const fetchFn = async (url: string): Promise<Response> => {
      calls.push(url);
      return new Response(badIndex, { status: 200 });
    };
    const res = await fetchSitemapSlugs({ ats: "hiringthing", fetchFn });
    // Only the index was fetched — the malformed child URL never fired a
    // request and minted no slug.
    expect(calls.length).toBe(1);
    expect(res.slugs).toEqual([]);
  });

  it("throws for an ATS with no sitemap source", async () => {
    const fetchFn = async (): Promise<Response> => new Response("", { status: 200 });
    await expect(fetchSitemapSlugs({ ats: "greenhouse", fetchFn })).rejects.toThrow();
  });

  it("defaults fetchFn to globalThis.fetch", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(ISOLVED_INDEX, { status: 200 })) as typeof fetch;
    try {
      const res = await fetchSitemapSlugs({ ats: "isolvedhire" });
      expect(res.slugs).toContain("davidsonoil");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("mergeSitemapSlugs", () => {
  const NOW = "2026-07-03T12:00:00.000Z";
  const EPOCH = "1970-01-01T00:00:00.000Z";
  const t = (
    slug: string,
    status: Tenant["status"],
    last = "2026-06-01T00:00:00.000Z",
  ): Tenant => ({
    ats: "jazzhr",
    slug,
    status,
    last_probed_at: last,
    first_seen_at: "2026-01-01T00:00:00.000Z",
  });

  it("appends a new slug as transient_failure with now timestamps", () => {
    const res = mergeSitemapSlugs({
      ats: "isolvedhire",
      existing: [],
      sitemapSlugs: ["acme"],
      liveElsewhere: new Set(),
      livenessTruth: false,
      now: NOW,
    });
    expect(res.added).toBe(1);
    expect(res.tenants).toHaveLength(1);
    const added = res.tenants[0];
    expect(added?.status).toBe("transient_failure");
    expect(added?.last_probed_at).toBe(NOW);
    expect(added?.first_seen_at).toBe(NOW);
    expect(added?.ats).toBe("isolvedhire");
  });

  it("leaves an existing live slug untouched (no demotion, counted skipped)", () => {
    const live = t("keepme", "live");
    const res = mergeSitemapSlugs({
      ats: "jazzhr",
      existing: [live],
      sitemapSlugs: ["keepme"],
      liveElsewhere: new Set(),
      livenessTruth: true,
      now: NOW,
    });
    expect(res.added).toBe(0);
    expect(res.resurrected).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.tenants[0]).toEqual(live);
  });

  it("resurrects a dead/transient slug in liveness-truth mode (epoch reset)", () => {
    const res = mergeSitemapSlugs({
      ats: "jazzhr",
      existing: [t("wasdead", "dead"), t("wastransient", "transient_failure")],
      sitemapSlugs: ["wasdead", "wastransient"],
      liveElsewhere: new Set(),
      livenessTruth: true,
      now: NOW,
    });
    expect(res.resurrected).toBe(2);
    for (const tt of res.tenants) {
      expect(tt.status).toBe("transient_failure");
      expect(tt.last_probed_at).toBe(EPOCH);
      // first_seen_at is preserved on resurrection.
      expect(tt.first_seen_at).toBe("2026-01-01T00:00:00.000Z");
    }
  });

  it("does NOT resurrect a dead slug when livenessTruth is false", () => {
    const dead = t("stilldead", "dead");
    const res = mergeSitemapSlugs({
      ats: "hiringthing",
      existing: [dead],
      sitemapSlugs: ["stilldead"],
      liveElsewhere: new Set(),
      livenessTruth: false,
      now: NOW,
    });
    expect(res.resurrected).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.tenants[0]).toEqual(dead);
  });

  it("does not re-resurrect a slug already reset to the epoch", () => {
    const res = mergeSitemapSlugs({
      ats: "jazzhr",
      existing: [t("pending", "transient_failure", EPOCH)],
      sitemapSlugs: ["pending"],
      liveElsewhere: new Set(),
      livenessTruth: true,
      now: NOW,
    });
    expect(res.resurrected).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.tenants[0]?.last_probed_at).toBe(EPOCH);
  });

  it("does not resurrect a slug just seeded at `now` this pass", () => {
    const res = mergeSitemapSlugs({
      ats: "jazzhr",
      existing: [t("fresh", "transient_failure", NOW)],
      sitemapSlugs: ["fresh"],
      liveElsewhere: new Set(),
      livenessTruth: true,
      now: NOW,
    });
    expect(res.resurrected).toBe(0);
    expect(res.tenants[0]?.last_probed_at).toBe(NOW);
  });

  it("skips a slug already live under another ATS (dedup guard)", () => {
    const res = mergeSitemapSlugs({
      ats: "jazzhr",
      existing: [t("dupdead", "dead")],
      sitemapSlugs: ["dupnew", "dupdead"],
      liveElsewhere: new Set(["dupnew", "dupdead"]),
      livenessTruth: true,
      now: NOW,
    });
    // Neither is added nor resurrected — both live elsewhere.
    expect(res.added).toBe(0);
    expect(res.resurrected).toBe(0);
    expect(res.skipped).toBe(2);
    // The existing dead record is preserved, not resurrected.
    expect(res.tenants[0]?.status).toBe("dead");
  });

  it("is deterministic, stable-sorted, and idempotent", () => {
    const existing = [t("beta", "live"), t("alpha", "dead")];
    const args = {
      ats: "jazzhr" as const,
      existing,
      sitemapSlugs: ["gamma", "alpha", "beta"],
      liveElsewhere: new Set<string>(),
      livenessTruth: true,
      now: NOW,
    };
    const first = mergeSitemapSlugs(args);
    expect(first.tenants.map((x) => x.slug)).toEqual(["alpha", "beta", "gamma"]);
    // Re-running on the merged output seeds/resurrects nothing new.
    const second = mergeSitemapSlugs({ ...args, existing: first.tenants });
    expect(second.added).toBe(0);
    // alpha was resurrected to transient_failure in pass 1; pass 2 sees it
    // as transient and (liveness-truth) resurrects again — but the record
    // is byte-identical, so the file content is stable.
    expect(second.tenants).toEqual(first.tenants);
  });
});
