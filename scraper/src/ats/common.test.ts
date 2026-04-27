import { describe, expect, it } from "bun:test";
import { HttpError } from "../http.ts";
import {
  assertSafeSlug,
  assertWorkdayHost,
  assertWorkdaySite,
  dedupeById,
  epochToIso,
  errorToResult,
  isRecruiterTitle,
} from "./common.ts";

describe("dedupeById", () => {
  it("keeps the first occurrence of each id", () => {
    const a = { id: "a", title: "A" } as any;
    const aDup = { id: "a", title: "A2" } as any;
    const b = { id: "b", title: "B" } as any;
    const out = dedupeById([a, aDup, b]);
    expect(out).toHaveLength(2);
    expect(out[0]?.title).toBe("A");
  });
});

describe("errorToResult", () => {
  it("maps transient HttpError to transient_failure", () => {
    const r = errorToResult("foo", new HttpError("transient", "503", 503));
    expect(r.status).toBe("transient_failure");
    expect(r.http_status).toBe(503);
  });

  it("maps permanent HttpError to dead", () => {
    const r = errorToResult("foo", new HttpError("permanent", "404", 404));
    expect(r.status).toBe("dead");
  });

  it("maps auth HttpError to dead", () => {
    const r = errorToResult("foo", new HttpError("auth", "403", 403));
    expect(r.status).toBe("dead");
  });

  it("omits http_status when none on the error", () => {
    const r = errorToResult("foo", new HttpError("transient", "net"));
    expect(r.http_status).toBeUndefined();
  });

  it("treats arbitrary errors as dead", () => {
    const r = errorToResult("foo", new Error("ouch"));
    expect(r.status).toBe("dead");
    expect(r.error).toBe("ouch");
  });

  it("treats non-Error throwables as dead with unknown error", () => {
    const r = errorToResult("foo", "weird");
    expect(r.status).toBe("dead");
    expect(r.error).toBe("unknown error");
  });
});

describe("isRecruiterTitle", () => {
  it("matches obvious recruiter titles", () => {
    expect(isRecruiterTitle("Technical Recruiter")).toBe(true);
    expect(isRecruiterTitle("Talent Acquisition Partner")).toBe(true);
    expect(isRecruiterTitle("Engineering Sourcer")).toBe(true);
    expect(isRecruiterTitle("Head of Talent")).toBe(true);
  });

  it("does not match engineering titles", () => {
    expect(isRecruiterTitle("Senior Software Engineer")).toBe(false);
    expect(isRecruiterTitle("Head of Engineering")).toBe(false);
  });
});

describe("assertSafeSlug", () => {
  it("accepts canonical slugs", () => {
    expect(() => assertSafeSlug("stripe")).not.toThrow();
    expect(() => assertSafeSlug("ok-slug-123")).not.toThrow();
  });

  it("rejects slugs with hostnames, slashes, dots, or uppercase", () => {
    expect(() => assertSafeSlug("evil.com")).toThrow();
    expect(() => assertSafeSlug("foo/bar")).toThrow();
    expect(() => assertSafeSlug("Stripe")).toThrow();
    expect(() => assertSafeSlug("")).toThrow();
    expect(() => assertSafeSlug("a".repeat(65))).toThrow();
  });

  it("rejects slugs with leading or trailing hyphens (RFC 1123)", () => {
    expect(() => assertSafeSlug("-acme")).toThrow();
    expect(() => assertSafeSlug("acme-")).toThrow();
    expect(() => assertSafeSlug("---")).toThrow();
  });
});

describe("assertWorkdayHost", () => {
  it("accepts canonical workday hosts", () => {
    expect(() => assertWorkdayHost("example.wd5.myworkdayjobs.com")).not.toThrow();
    expect(() => assertWorkdayHost("co-op.wd1.myworkdayjobs.com")).not.toThrow();
  });

  it("accepts impl/sandbox tier workday hosts (wd5-impl)", () => {
    expect(() => assertWorkdayHost("acme.wd5-impl.myworkdayjobs.com")).not.toThrow();
    expect(() => assertWorkdayHost("acme.wd103-2.myworkdayjobs.com")).not.toThrow();
  });

  it("rejects non-workday hosts", () => {
    expect(() => assertWorkdayHost("evil.com")).toThrow();
    expect(() => assertWorkdayHost("example.wdN.myworkdayjobs.com")).toThrow();
    expect(() => assertWorkdayHost("example.wd5.myworkdayjobs.com.attacker.com")).toThrow();
  });
});

describe("assertWorkdaySite", () => {
  it("accepts canonical sites", () => {
    expect(() => assertWorkdaySite("External")).not.toThrow();
    expect(() => assertWorkdaySite("Careers_Site-1")).not.toThrow();
  });

  it("rejects sites with slashes or punctuation", () => {
    expect(() => assertWorkdaySite("../etc")).toThrow();
    expect(() => assertWorkdaySite("a b")).toThrow();
    expect(() => assertWorkdaySite("")).toThrow();
  });
});

describe("epochToIso", () => {
  it("converts ms epoch to ISO Z string", () => {
    expect(epochToIso(1_700_000_000_000)).toBe("2023-11-14T22:13:20.000Z");
  });

  it("returns undefined for undefined and non-finite", () => {
    expect(epochToIso(undefined)).toBeUndefined();
    expect(epochToIso(Number.NaN)).toBeUndefined();
    expect(epochToIso(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});
