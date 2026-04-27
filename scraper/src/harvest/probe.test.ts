import { afterEach, describe, expect, it, mock } from "bun:test";
import { HttpClient } from "../http.ts";
import { RobotsTxtCache } from "../robots.ts";
import { probeMany, probeOne, probeUrlFor } from "./probe.ts";

const OBSERVED_AT = "2026-04-26T00:00:00Z";

afterEach(() => mock.restore());

const ROBOTS_OK = new RobotsTxtCache({
  fetchFn: async () => new Response("", { status: 404 }),
  clock: () => 0,
});

function clientWith(fetchFn: typeof globalThis.fetch): HttpClient {
  return new HttpClient({
    userAgent: "openroles/0.0.0 (+https://example.com)",
    robots: ROBOTS_OK,
    fetchFn,
    sleep: async () => {},
    random: () => 0.5,
    retry: { maxAttempts: 1, baseMs: 1, maxMs: 1 },
  });
}

describe("probeUrlFor", () => {
  it("emits the canonical probe URL per ATS", () => {
    expect(probeUrlFor("greenhouse", "stripe")).toContain("/boards/stripe/jobs");
    expect(probeUrlFor("lever", "stripe")).toContain("/v0/postings/stripe");
    expect(probeUrlFor("ashby", "stripe")).toContain("/posting-api/job-board/stripe");
    expect(probeUrlFor("bamboohr", "stripe")).toContain("stripe.bamboohr.com");
    // iCIMS slug is the full subdomain label — most real tenants don't use
    // a `careers-` prefix, so the probe URL composes `{slug}.icims.com`.
    expect(probeUrlFor("icims", "careers-stripe")).toContain("careers-stripe.icims.com");
    expect(probeUrlFor("icims", "1stheritage-attainfinance")).toContain(
      "1stheritage-attainfinance.icims.com",
    );
    expect(probeUrlFor("recruitee", "stripe")).toContain("stripe.recruitee.com/api/offers");
    expect(probeUrlFor("breezy", "stripe")).toContain("stripe.breezy.hr/json");
    expect(probeUrlFor("personio", "stripe")).toContain("stripe.jobs.personio.com/xml");
    expect(probeUrlFor("workable", "stripe")).toContain(
      "apply.workable.com/api/v3/accounts/stripe/jobs",
    );
    expect(probeUrlFor("teamtailor", "stripe")).toContain("stripe.teamtailor.com/jobs.json");
    expect(probeUrlFor("smartrecruiters", "stripe")).toContain(
      "api.smartrecruiters.com/v1/companies/stripe/postings",
    );
  });

  it("throws for ATSes with no probe URL configured (defensive)", () => {
    // workday is intentionally absent; site/host pair are tenant metadata.
    expect(() => probeUrlFor("workday", "stripe")).toThrow();
  });
});

describe("probeOne", () => {
  it("classifies a 200 response as live", async () => {
    const fetchFn = mock(async () => new Response("[]", { status: 200 }));
    const t = await probeOne("greenhouse", "stripe", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("live");
  });

  it("classifies 404 / 410 as dead", async () => {
    const dead404 = mock(async () => new Response("nope", { status: 404 }));
    const t1 = await probeOne("greenhouse", "stripe", clientWith(dead404), OBSERVED_AT);
    expect(t1.status).toBe("dead");

    const dead410 = mock(async () => new Response("gone", { status: 410 }));
    const t2 = await probeOne("greenhouse", "stripe", clientWith(dead410), OBSERVED_AT);
    expect(t2.status).toBe("dead");
  });

  it("classifies 401 / 403 (auth) as dead", async () => {
    const fetchFn = mock(async () => new Response("nope", { status: 403 }));
    const t = await probeOne("greenhouse", "stripe", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("dead");
  });

  it("classifies 5xx and 429 as transient_failure", async () => {
    const fetchFn = mock(async () => new Response("bad", { status: 503 }));
    const t = await probeOne("greenhouse", "stripe", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("transient_failure");
  });

  it("classifies network errors as transient_failure", async () => {
    const fetchFn = mock(async () => {
      throw new Error("network down");
    });
    const t = await probeOne("greenhouse", "stripe", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("transient_failure");
  });

  it("rejects invalid slugs without making a request", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const t = await probeOne("greenhouse", "evil.com", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("dead");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns transient_failure for workday (probe deferred)", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const t = await probeOne("workday", "stripe", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("transient_failure");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("probeMany", () => {
  it("probes a list of slugs respecting concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchFn = mock(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return new Response("[]", { status: 200 });
    });
    const tenants = await probeMany("greenhouse", ["a", "b", "c", "d", "e", "f", "g"], {
      client: clientWith(fetchFn),
      observedAt: OBSERVED_AT,
      concurrency: 2,
    });
    expect(tenants).toHaveLength(7);
    expect(peak).toBeLessThanOrEqual(2);
    expect(tenants.every((t) => t.status === "live")).toBe(true);
  });
});
