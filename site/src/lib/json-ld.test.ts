import { describe, expect, it } from "bun:test";
import { jsonLdSafe } from "./json-ld.ts";

describe("jsonLdSafe", () => {
  it("round-trips a simple object", () => {
    const payload = { hello: "world" };
    expect(JSON.parse(jsonLdSafe(payload))).toEqual(payload);
  });

  it("escapes < > & so a description containing </script> cannot break the script context", () => {
    const out = jsonLdSafe({ description: "If you write </script>, …" });
    expect(out).not.toContain("</script>");
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    // Round-trips back to the original value when re-parsed.
    expect(JSON.parse(out)).toEqual({ description: "If you write </script>, …" });
  });

  it("escapes ampersands so injected entities cannot break content interpretation", () => {
    const out = jsonLdSafe({ q: "M&Ms" });
    expect(out).toContain("\\u0026");
    expect(out).not.toMatch(/&(?!\\)/); // no bare ampersands
    expect(JSON.parse(out)).toEqual({ q: "M&Ms" });
  });

  it("escapes U+2028 and U+2029 (which JSON.stringify lets through but JS engines treat as line terminators)", () => {
    const value = `line1${String.fromCharCode(0x2028)}line2${String.fromCharCode(0x2029)}line3`;
    const out = jsonLdSafe({ value });
    expect(out).toContain("\\u2028");
    expect(out).toContain("\\u2029");
    expect(JSON.parse(out)).toEqual({ value });
  });

  it("emits valid JSON for nested structures", () => {
    const ld = {
      "@context": "https://schema.org",
      "@type": "JobPosting",
      title: "Senior <Engineer>",
      description: "Build <script>foo</script> things",
      hiringOrganization: { "@type": "Organization", name: "AT&T" },
    };
    const out = jsonLdSafe(ld);
    expect(JSON.parse(out)).toEqual(ld);
    // None of the dangerous characters survive in the literal output.
    for (const ch of ["<", ">", "&"]) {
      expect(out).not.toContain(ch);
    }
  });
});
