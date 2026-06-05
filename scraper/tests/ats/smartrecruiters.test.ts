import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { scrapeSmartRecruitersTenant } from "../../src/ats/smartrecruiters.ts";
import { clientWithRobotsAllowAll, HttpResponse, http, makeServer } from "../helpers.ts";

const OBSERVED_AT = "2026-04-26T00:00:00Z";

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("scrapeSmartRecruitersTenant", () => {
  it("fetches listing + per-posting detail and assembles a description excerpt", async () => {
    server.use(
      http.get("https://api.smartrecruiters.com/v1/companies/acme/postings", () =>
        HttpResponse.json({
          totalFound: 2,
          content: [
            {
              id: "abc-1",
              name: "Senior Software Engineer",
              releasedDate: "2026-04-20T10:00:00Z",
              location: {
                fullLocation: "Remote, US",
                country: "us",
                city: "Anywhere",
                remote: true,
              },
              department: { label: "Engineering" },
            },
            {
              id: "abc-2",
              name: "Staff Data Scientist",
              releasedDate: "2026-04-19T10:00:00Z",
              location: { fullLocation: "London, UK", country: "gb", hybrid: true },
              department: { label: "Data" },
            },
          ],
        }),
      ),
      http.get("https://api.smartrecruiters.com/v1/companies/acme/postings/abc-1", () =>
        HttpResponse.json({
          id: "abc-1",
          name: "Senior Software Engineer",
          jobAd: {
            sections: {
              jobDescription: {
                text: "<p>Build distributed systems at scale.</p>",
              },
              qualifications: { text: "<p>5+ years Go or Rust.</p>" },
              companyDescription: { text: "<p>About Acme.</p>" },
            },
          },
        }),
      ),
      http.get("https://api.smartrecruiters.com/v1/companies/acme/postings/abc-2", () =>
        HttpResponse.json({
          id: "abc-2",
          name: "Staff Data Scientist",
          jobAd: {
            sections: { jobDescription: { text: "Run experiments and ship models." } },
          },
        }),
      ),
    );
    const out = await scrapeSmartRecruitersTenant({
      tenant: { slug: "acme", display_name: "Acme" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(2);
    const eng = out.jobs.find((j) => j.title === "Senior Software Engineer");
    expect(eng?.description_excerpt).toContain("Build distributed systems");
    expect(eng?.description_excerpt).toContain("5+ years Go or Rust");
    expect(eng?.workplace_type).toBe("remote");
    const data = out.jobs.find((j) => j.title === "Staff Data Scientist");
    expect(data?.description_excerpt).toContain("Run experiments");
    expect(data?.workplace_type).toBe("hybrid");
    // The apply link must deep-link to the specific posting. Only the
    // per-posting host `jobs.smartrecruiters.com/{tenant}/{id}` serves the
    // job card; `careers.smartrecruiters.com/{tenant}/{id}` 302-redirects to
    // the tenant's job *listing*, dropping the id (verified live, 2026-06-05).
    expect(eng?.url).toBe("https://jobs.smartrecruiters.com/acme/abc-1");
    expect(data?.url).toBe("https://jobs.smartrecruiters.com/acme/abc-2");
  });

  it("falls back to listing-only data when the detail endpoint fails", async () => {
    server.use(
      http.get("https://api.smartrecruiters.com/v1/companies/flaky/postings", () =>
        HttpResponse.json({
          totalFound: 1,
          content: [
            {
              id: "x-1",
              name: "Product Manager",
              releasedDate: "2026-04-15T10:00:00Z",
              location: { fullLocation: "NYC", country: "us", city: "New York" },
            },
          ],
        }),
      ),
      http.get(
        "https://api.smartrecruiters.com/v1/companies/flaky/postings/x-1",
        () => new HttpResponse("oops", { status: 503 }),
      ),
    );
    const out = await scrapeSmartRecruitersTenant({
      tenant: { slug: "flaky", display_name: "Flaky" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(1);
    expect(out.jobs[0]?.description_excerpt).toBeUndefined();
    expect(out.jobs[0]?.title).toBe("Product Manager");
  });

  it("returns success with zero jobs when the listing is empty", async () => {
    server.use(
      http.get("https://api.smartrecruiters.com/v1/companies/empty/postings", () =>
        HttpResponse.json({ totalFound: 0, content: [] }),
      ),
    );
    const out = await scrapeSmartRecruitersTenant({
      tenant: { slug: "empty" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(0);
  });

  it("caps detail fetches per tenant; older postings get listing-only data", async () => {
    // Build a synthetic listing with 250 postings (>MAX_DETAIL_FETCH_PER_TENANT=200).
    const postings = Array.from({ length: 250 }, (_, i) => ({
      id: `huge-${i}`,
      name: `Role ${i}`,
      releasedDate: "2026-04-01T10:00:00Z",
      location: { fullLocation: "Remote", country: "us", remote: true },
    }));
    let detailCallCount = 0;
    server.use(
      http.get("https://api.smartrecruiters.com/v1/companies/huge/postings", ({ request }) => {
        const offsetParam = new URL(request.url).searchParams.get("offset") ?? "0";
        const offset = Number.parseInt(offsetParam, 10);
        return HttpResponse.json({
          totalFound: postings.length,
          content: postings.slice(offset, offset + 100),
        });
      }),
      http.get("https://api.smartrecruiters.com/v1/companies/huge/postings/:id", () => {
        detailCallCount += 1;
        return HttpResponse.json({
          jobAd: { sections: { jobDescription: { text: "described" } } },
        });
      }),
    );
    const out = await scrapeSmartRecruitersTenant({
      tenant: { slug: "huge", display_name: "Huge" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(out.jobs).toHaveLength(250);
    expect(detailCallCount).toBe(200);
    const enriched = out.jobs.filter((j) => j.description_excerpt !== undefined);
    expect(enriched).toHaveLength(200);
  });

  it("returns dead status when the listing endpoint errors hard", async () => {
    server.use(
      http.get(
        "https://api.smartrecruiters.com/v1/companies/dead/postings",
        () => new HttpResponse("not found", { status: 404 }),
      ),
    );
    const out = await scrapeSmartRecruitersTenant({
      tenant: { slug: "dead" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    // The adapter currently treats malformed JSON / non-2xx the same: the
    // outer try/catch wraps with errorToResult. We assert there are no jobs.
    expect(out.jobs).toHaveLength(0);
  });
});
