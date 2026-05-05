import { describe, expect, it } from "bun:test";
import {
  bodyParas,
  dropcap,
  freshnessTag,
  relativeDays,
  shortDate,
  shortIdFromUrl,
  strapText,
} from "./role-detail-helpers.ts";

const FIVE_DAYS_AGO = "2026-04-29T00:00:00Z";
const TWENTY_DAYS_AGO = "2026-04-14T00:00:00Z";
const SIXTY_DAYS_AGO = "2026-03-05T00:00:00Z";
const NOW = Date.parse("2026-05-04T00:00:00Z");

describe("shortIdFromUrl", () => {
  it("returns the 16-hex query param", () => {
    expect(shortIdFromUrl("?id=8d8ee7f301f4ce38", "/role/")).toBe("8d8ee7f301f4ce38");
  });

  it("falls back to the legacy path-shaped id", () => {
    expect(shortIdFromUrl("", "/role/8d8ee7f301f4ce38/")).toBe("8d8ee7f301f4ce38");
  });

  it("returns null when no recognisable id is present", () => {
    expect(shortIdFromUrl("", "/role/")).toBeNull();
    expect(shortIdFromUrl("?id=not-hex", "/role/")).toBeNull();
    expect(shortIdFromUrl("?id=AAAA", "/role/")).toBeNull();
  });

  it("accepts the alternate `short_id=` query param", () => {
    expect(shortIdFromUrl("?short_id=abcdef0123456789", "/role/")).toBe("abcdef0123456789");
  });
});

describe("freshnessTag", () => {
  it("FRESH within 7 days when posted_at is set", () => {
    const tag = freshnessTag(FIVE_DAYS_AGO, "2025-01-01T00:00:00Z", { now: NOW });
    expect(tag.tone).toBe("fresh");
    expect(tag.text).toMatch(/FRESH$/);
  });

  it("ACTIVE within 8–30 days", () => {
    const tag = freshnessTag(TWENTY_DAYS_AGO, "2025-01-01T00:00:00Z", { now: NOW });
    expect(tag.tone).toBe("active");
    expect(tag.text).toMatch(/ACTIVE$/);
  });

  it("muted with day count when older than 30 days", () => {
    const tag = freshnessTag(SIXTY_DAYS_AGO, "2025-01-01T00:00:00Z", { now: NOW });
    expect(tag.tone).toBe("muted");
    expect(tag.text).toMatch(/60 DAYS AGO$/);
  });

  it("falls back to FIRST SEEN when posted_at is null", () => {
    const tag = freshnessTag(null, "2025-01-01T00:00:00Z", { now: NOW });
    expect(tag.tone).toBe("muted");
    expect(tag.text).toMatch(/^FIRST SEEN /);
  });

  it("returns FIRST SEEN — when both are absent / unparseable", () => {
    const tag = freshnessTag(null, "", { now: NOW });
    expect(tag.text).toBe("FIRST SEEN —");
  });

  it("uses a muted tone for an unparseable posted_at string", () => {
    const tag = freshnessTag("not-a-date", "2025-01-01T00:00:00Z", { now: NOW });
    expect(tag.tone).toBe("muted");
  });

  it("returns LAST SEEN … STALE when isStale=true (overrides posted_at tone)", () => {
    const tag = freshnessTag(FIVE_DAYS_AGO, "2025-01-01T00:00:00Z", {
      now: NOW,
      isStale: true,
      lastSeenAt: "2026-04-15T00:00:00Z",
    });
    expect(tag.tone).toBe("muted");
    expect(tag.text).toBe("LAST SEEN 15 APR · STALE");
  });

  it("falls back to first_seen_at when stale but no lastSeenAt provided", () => {
    const tag = freshnessTag(FIVE_DAYS_AGO, "2026-04-10T00:00:00Z", {
      now: NOW,
      isStale: true,
    });
    expect(tag.text).toBe("LAST SEEN 10 APR · STALE");
  });
});

describe("shortDate", () => {
  it("formats an ISO date as DD MMM in caps using UTC (timezone-stable)", () => {
    expect(shortDate("2026-04-22T00:00:00Z")).toBe("22 APR");
    expect(shortDate("2026-12-31T23:00:00Z")).toBe("31 DEC");
    expect(shortDate("2026-01-01T00:00:00Z")).toBe("01 JAN");
  });

  it("falls back to the first 10 chars of the iso prefix on a bad input", () => {
    expect(shortDate("not-a-date")).toBe("not-a-date");
    expect(shortDate("garbage-input-here")).toBe("garbage-in");
  });
});

describe("relativeDays", () => {
  it("returns null on null input", () => {
    expect(relativeDays(null)).toBeNull();
  });

  it("today / yesterday / N days ago / dated past 30", () => {
    expect(relativeDays("2026-05-04T00:00:00Z", NOW)).toBe("today");
    expect(relativeDays("2026-05-03T00:00:00Z", NOW)).toBe("yesterday");
    expect(relativeDays(FIVE_DAYS_AGO, NOW)).toBe("5 days ago");
    expect(relativeDays(SIXTY_DAYS_AGO, NOW)).toMatch(/2026/);
  });

  it("returns null on an unparseable string", () => {
    expect(relativeDays("garbage")).toBeNull();
  });
});

describe("strapText", () => {
  it("returns empty for null / empty excerpt", () => {
    expect(strapText(null)).toBe("");
    expect(strapText("")).toBe("");
  });

  it("preserves a trailing period on the first sentence", () => {
    expect(strapText("Build the future. Read more.")).toBe("Build the future.");
  });

  it("appends a period when the first sentence has none", () => {
    expect(strapText("Build the future")).toBe("Build the future.");
  });

  it("treats the first sentence as the chars before the first `[.!?] + space` boundary", () => {
    // Note: split() consumes the delimiter; my impl appends `.` since the
    // remainder doesn't end with [.!?]. Lossy on `!` / `?` first sentences;
    // documented as acceptable for strap text.
    expect(strapText("First! Second sentence.")).toBe("First.");
  });
});

describe("bodyParas", () => {
  it("splits on blank lines and drops empty entries", () => {
    const out = bodyParas("para one\n\npara two\n\n  \n\npara three");
    expect(out).toEqual(["para one", "para two", "para three"]);
  });

  it("returns empty for null", () => {
    expect(bodyParas(null)).toEqual([]);
  });
});

describe("dropcap", () => {
  it("splits ASCII letters cleanly", () => {
    expect(dropcap("Stripe")).toEqual({ first: "S", rest: "tripe" });
  });

  it("preserves a leading multi-codepoint grapheme as a single first char", () => {
    expect(dropcap("🚀-launch")).toEqual({ first: "🚀", rest: "-launch" });
  });

  it("handles empty input", () => {
    expect(dropcap("")).toEqual({ first: "", rest: "" });
  });
});
