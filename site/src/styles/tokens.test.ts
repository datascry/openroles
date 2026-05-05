import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_ROOT = join(import.meta.dir, "..");
const TOKENS_PATH = join(import.meta.dir, "tokens.css");
const GLOBAL_PATH = join(import.meta.dir, "global.css");

const TOKEN_DEFINITION_RE = /(--[a-z0-9-]+)\s*:/gi;
const VAR_REFERENCE_RE = /var\((\s*)(--[a-z0-9-]+)/gi;
const STYLE_BLOCK_RE = /<style[^>]*>([\s\S]*?)<\/style>/g;
const INLINE_STYLE_ATTR_RE = /\bstyle\s*=\s*"([^"]*)"/g;

const SOURCE_EXTENSIONS = [".svelte", ".astro", ".css"];
const SKIP_DIRS = new Set(["node_modules", ".astro", "dist", "coverage"]);

/**
 * Open Props ships ~hundreds of CSS variables. Rather than try to enumerate
 * them here, the test allowlists prefixes that are known to come from the
 * `open-props/style` import. Any future references should fall under one
 * of these prefixes; if not, the prefix should be added explicitly.
 */
const OPEN_PROPS_PREFIXES: ReadonlyArray<string> = [
  "--ease-",
  "--size-",
  "--font-",
  "--shadow-",
  "--border-size-",
  "--radius-",
  "--ratio-",
  "--layer-",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walk(full, out);
    } else if (SOURCE_EXTENSIONS.some((ext) => full.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

function extractDefinedTokens(css: string): Set<string> {
  const out = new Set<string>();
  for (const match of css.matchAll(TOKEN_DEFINITION_RE)) {
    if (match[1]) out.add(match[1]);
  }
  return out;
}

function extractCssFromSource(filePath: string, body: string): string {
  if (filePath.endsWith(".css")) return body;
  const styleBlocks: string[] = [];
  for (const match of body.matchAll(STYLE_BLOCK_RE)) {
    if (match[1]) styleBlocks.push(match[1]);
  }
  const inlineStyles: string[] = [];
  for (const match of body.matchAll(INLINE_STYLE_ATTR_RE)) {
    if (match[1]) inlineStyles.push(match[1]);
  }
  return [...styleBlocks, ...inlineStyles].join("\n");
}

function extractReferencedTokens(css: string): Set<string> {
  const out = new Set<string>();
  for (const match of css.matchAll(VAR_REFERENCE_RE)) {
    if (match[2]) out.add(match[2]);
  }
  return out;
}

function isOpenPropsToken(token: string): boolean {
  return OPEN_PROPS_PREFIXES.some((prefix) => token.startsWith(prefix));
}

describe("CSS tokens (workspace-wide)", () => {
  const tokensCss = readFileSync(TOKENS_PATH, "utf8");
  const globalCss = readFileSync(GLOBAL_PATH, "utf8");
  const definedTokens = new Set([
    ...extractDefinedTokens(tokensCss),
    ...extractDefinedTokens(globalCss),
  ]);
  const sourceFiles = walk(SRC_ROOT).filter(
    (p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"),
  );

  it("walked at least one Svelte and one Astro source file", () => {
    expect(sourceFiles.some((p) => p.endsWith(".svelte"))).toBe(true);
    expect(sourceFiles.some((p) => p.endsWith(".astro"))).toBe(true);
  });

  it("does not reference dead tokens removed by the Brutalist Press migration", () => {
    const dead = ["--color-muted", "--color-surface-2", "--color-border"];
    const violations: Array<{ file: string; token: string }> = [];
    for (const file of sourceFiles) {
      const body = readFileSync(file, "utf8");
      const css = extractCssFromSource(file, body);
      const refs = extractReferencedTokens(css);
      for (const token of dead) {
        if (refs.has(token)) {
          violations.push({ file: relative(SRC_ROOT, file), token });
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("does not reference any non-existent --font-size-N token (use --text-N)", () => {
    const violations: Array<{ file: string; token: string }> = [];
    for (const file of sourceFiles) {
      const body = readFileSync(file, "utf8");
      const css = extractCssFromSource(file, body);
      const refs = extractReferencedTokens(css);
      for (const token of refs) {
        if (token.startsWith("--font-size-")) {
          violations.push({ file: relative(SRC_ROOT, file), token });
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("every var() reference resolves to a defined token (or an Open Props prefix)", () => {
    const violations: Array<{ file: string; token: string }> = [];
    for (const file of sourceFiles) {
      const body = readFileSync(file, "utf8");
      const css = extractCssFromSource(file, body);
      const refs = extractReferencedTokens(css);
      for (const token of refs) {
        if (definedTokens.has(token)) continue;
        if (isOpenPropsToken(token)) continue;
        violations.push({ file: relative(SRC_ROOT, file), token });
      }
    }
    expect(violations).toEqual([]);
  });
});
