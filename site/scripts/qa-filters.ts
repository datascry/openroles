// Drive the live site through every filter dimension, measure how each
// query terminates (rows rendered, empty state, error, or hang), and
// summarise. Used to spot regressions where a filter that should match
// thousands of rows lands on the empty path or never returns.
//
// Run: bun run scripts/qa-filters.ts [base-url]

import { type Browser, chromium } from "@playwright/test";

const BASE = process.argv[2] ?? "https://openroles.today/";
const PER_TEST_TIMEOUT_MS = 90_000;

function emit(line: string): void {
  process.stdout.write(`${line}\n`);
}

interface FilterCase {
  readonly name: string;
  readonly query: string;
  /** What outcome we expect — 'rows' if results should be present, 'either' if empty is acceptable. */
  readonly expect: "rows" | "either";
}

const CASES: ReadonlyArray<FilterCase> = [
  { name: "default", query: "", expect: "rows" },
  { name: "ats=greenhouse", query: "?ats=greenhouse", expect: "rows" },
  { name: "ats=lever", query: "?ats=lever", expect: "rows" },
  { name: "ats=icims", query: "?ats=icims", expect: "rows" },
  { name: "ats=workday (small set)", query: "?ats=workday", expect: "either" },
  { name: "ats=greenhouse,lever (multi)", query: "?ats=greenhouse,lever", expect: "rows" },
  { name: "level=senior", query: "?level=senior", expect: "rows" },
  { name: "level=staff", query: "?level=staff", expect: "rows" },
  { name: "level=junior+mid (multi)", query: "?level=junior,mid", expect: "rows" },
  { name: "wt=remote", query: "?wt=remote", expect: "rows" },
  { name: "wt=hybrid", query: "?wt=hybrid", expect: "rows" },
  { name: "wt=onsite", query: "?wt=onsite", expect: "rows" },
  { name: "since=24h", query: "?since=24h", expect: "either" },
  { name: "since=7d", query: "?since=7d", expect: "rows" },
  { name: "since=30d", query: "?since=30d", expect: "rows" },
  { name: "hideRecruiter", query: "?recruiter=0", expect: "rows" },
  { name: "hideStale", query: "?hide_stale=1", expect: "rows" },
  { name: "minComp=100k", query: "?min_comp=100000", expect: "rows" },
  { name: "sort=posted_at:desc", query: "?sort=posted_at%3Adesc", expect: "rows" },
  { name: "sort=company:asc", query: "?sort=company%3Aasc", expect: "rows" },
  { name: "sort=level:asc", query: "?sort=level%3Aasc", expect: "rows" },
  { name: "q=engineer (FTS)", query: "?q=engineer", expect: "rows" },
  { name: "q=designer (FTS)", query: "?q=designer", expect: "rows" },
  {
    name: "q=garbledxxxnobodywilltype (FTS no match)",
    query: "?q=garbledxxxnobodywilltype",
    expect: "either",
  },
  {
    name: "stack: ats=greenhouse + level=senior + wt=remote",
    query: "?ats=greenhouse&level=senior&wt=remote",
    expect: "rows",
  },
  { name: "page=2", query: "?page=2", expect: "rows" },
];

interface CaseResult {
  readonly name: string;
  readonly outcome: "rows" | "empty" | "error" | "timeout";
  readonly rowCount: number;
  readonly totalCount: string | null;
  readonly errorText: string | null;
  readonly xhrCount: number;
  readonly elapsedMs: number;
}

async function runCase(browser: Browser, caseSpec: FilterCase): Promise<CaseResult> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let xhrCount = 0;
  page.on("console", (msg) => {
    const t = msg.text();
    if (t.startsWith("[xhr of size ")) xhrCount += 1;
  });
  const start = Date.now();
  try {
    await page.goto(`${BASE}${caseSpec.query}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    let outcome: "rows" | "empty" | "error" | "timeout" = "timeout";
    let rowCount = 0;
    let totalCount: string | null = null;
    let errorText: string | null = null;
    const deadline = Date.now() + PER_TEST_TIMEOUT_MS;
    // `.data-empty` renders the moment dbStatus flips to "ready" AND
    // rows is the initial []. That happens before the first SELECT
    // returns, so we can't trust an immediate empty paint. Wait for
    // either: rows render, an explicit error, or the XHR count goes
    // quiet for ≥3s with the page in a settled empty state.
    let lastXhr = -1;
    let lastXhrChangeAt = Date.now();
    while (Date.now() < deadline) {
      const snap = await page.evaluate(() => {
        const err = document.querySelector(".data-error");
        const errText = err?.textContent?.trim() ?? null;
        const rows = document.querySelectorAll("li.job").length;
        const empty = !!document.querySelector(".data-empty");
        const status = document.querySelector(".results-status")?.textContent?.trim() ?? null;
        return { errText, rows, empty, status };
      });
      rowCount = snap.rows;
      totalCount = snap.status;
      errorText = snap.errText;
      if (snap.errText && snap.errText.length > 0) {
        outcome = "error";
        break;
      }
      if (snap.rows > 0) {
        outcome = "rows";
        break;
      }
      if (xhrCount !== lastXhr) {
        lastXhr = xhrCount;
        lastXhrChangeAt = Date.now();
      }
      const quietFor = Date.now() - lastXhrChangeAt;
      if (snap.empty && quietFor > 3_000 && lastXhr > 5) {
        outcome = "empty";
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return {
      name: caseSpec.name,
      outcome,
      rowCount,
      totalCount,
      errorText,
      xhrCount,
      elapsedMs: Date.now() - start,
    };
  } finally {
    await ctx.close();
  }
}

async function main(): Promise<void> {
  emit(`base: ${BASE}`);
  emit(`cases: ${CASES.length}`);
  const browser = await chromium.launch({ headless: true });

  // Run cases SEQUENTIALLY so they share cache state and don't hammer
  // the CDN — each case spawns a fresh BrowserContext which is enough
  // to keep the FilterTable's URL state independent.
  const results: CaseResult[] = [];
  for (const c of CASES) {
    emit(`\n=== ${c.name} (${c.query || "<no params>"}) ===`);
    const res = await runCase(browser, c);
    results.push(res);
    const expectedOk = c.expect === "either" || res.outcome === "rows";
    const flag = expectedOk ? "✓" : "✗";
    emit(
      `  ${flag} ${res.outcome.padEnd(7)} rows=${res.rowCount} status="${res.totalCount}" xhrs=${res.xhrCount} ${res.elapsedMs}ms${res.errorText ? ` err="${res.errorText}"` : ""}`,
    );
  }
  await browser.close();

  emit("\n=== summary ===");
  const failures = results.filter((r, i) => {
    const c = CASES[i];
    return c?.expect === "rows" && r.outcome !== "rows";
  });
  emit(`pass: ${results.length - failures.length}/${results.length}`);
  if (failures.length > 0) {
    emit("failures:");
    for (const f of failures) emit(`  - ${f.name}: ${f.outcome} (${f.elapsedMs}ms)`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  emit(`[fatal] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
