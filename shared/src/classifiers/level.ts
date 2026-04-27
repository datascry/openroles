import type { Level } from "../schema/level.ts";

interface Pattern {
  readonly level: NonNullable<Level>;
  readonly re: RegExp;
}

const TECH_NOUN =
  "engineer(?:ing)?|developer|architect|designer|software|data|product|platform|infrastructure|frontend|backend|fullstack|full[-\\s]?stack|sre|devops|ml|ai|qa|test|security|technical";

const PATTERNS: ReadonlyArray<Pattern> = [
  { level: "director", re: /\bdirector\b/i },
  { level: "director", re: /\bhead\s+of\b/i },
  { level: "manager", re: /\bmanager\b|\bmgr\b/i },
  { level: "lead", re: new RegExp(`(?:^|\\s)lead\\s+(?:${TECH_NOUN})\\b`, "i") },
  { level: "principal", re: /\bprincipal\b/i },
  { level: "staff", re: /\bstaff\b/i },
  { level: "senior", re: /\bsenior\b|\bsr\.?\b/i },
  { level: "junior", re: /\bjunior\b|\bjr\.?\b/i },
  { level: "intern", re: /\bintern(?:ship)?\b/i },
  { level: "entry", re: /\bentry[-\s]?level\b/i },
  { level: "entry", re: /\bnew\s+grad\b/i },
  { level: "entry", re: /\bgraduate\b/i },
  { level: "entry", re: new RegExp(`\\bassociate\\s+(?:${TECH_NOUN})\\b`, "i") },
  { level: "mid", re: /\b(?:i{2,3}|[23])\b/i },
];

export function classifyLevel(title: string): Level {
  if (title.trim().length === 0) return null;
  for (const { level, re } of PATTERNS) {
    if (re.test(title)) return level;
  }
  return null;
}
