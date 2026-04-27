import type { Level } from "../schema/level.ts";

interface Pattern {
  readonly level: NonNullable<Level>;
  readonly re: RegExp;
}

const TECH_NOUN =
  "engineer(?:ing)?|developer|architect|designer|software|data|product|platform|infrastructure|frontend|backend|fullstack|full[-\\s]?stack|sre|devops|ml|ai|qa|test|security|technical";

// Priority order: most senior wins. "Senior Engineering Manager" → manager (not senior),
// "Senior Director" → director (not senior), "Lead Generation" never matches lead.
// First-match-wins, so each pattern must avoid eating titles meant for an earlier level.
const PATTERNS: ReadonlyArray<Pattern> = [
  { level: "director", re: /\bdirector\b/i },
  { level: "director", re: /\bhead\s+of\b/i },
  { level: "manager", re: /\bmanager\b|\bmgr\b/i },
  // lead may appear before a tech noun ("Lead Engineer"), after a tech-context noun
  // ("Engineering Lead", "Tech Lead"), or as a comma-suffixed seniority marker.
  {
    level: "lead",
    re: new RegExp(
      `(?:^|\\s)lead\\s+(?:${TECH_NOUN})\\b|\\b(?:tech|engineering|technical)\\s+lead\\b|(?:^|\\s)lead\\s*,\\s*(?:${TECH_NOUN}|engineering)\\b`,
      "i",
    ),
  },
  { level: "principal", re: /\bprincipal\b/i },
  { level: "staff", re: /\bstaff\b/i },
  { level: "senior", re: /\bsenior\b|\bsr\.?\b/i },
  { level: "junior", re: /\bjunior\b|\bjr\.?\b/i },
  { level: "intern", re: /\bintern(?:ship)?\b/i },
  { level: "entry", re: /\bentry[-\s]?level\b/i },
  { level: "entry", re: /\bnew\s+grad\b/i },
  { level: "entry", re: new RegExp(`\\bgraduate\\s+(?:${TECH_NOUN})\\b`, "i") },
  { level: "entry", re: new RegExp(`\\bassociate\\s+(?:${TECH_NOUN})\\b`, "i") },
  // mid: only when the title carries a tech noun followed by a roman/arabic level token,
  // so "Customer 3" / "Tier 2" / "Vice President 3" never match.
  {
    level: "mid",
    re: new RegExp(`\\b(?:${TECH_NOUN})\\s+(?:i{2,3}|iv|v|[2-5])\\b`, "i"),
  },
];

export function classifyLevel(title: string): Level {
  if (title.trim().length === 0) return null;
  for (const { level, re } of PATTERNS) {
    if (re.test(title)) return level;
  }
  return null;
}
