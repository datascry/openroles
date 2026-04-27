interface Rule {
  readonly allow: boolean;
  readonly path: string;
}

export interface RobotsRules {
  isAllowed(path: string, userAgent: string): boolean;
}

const ALLOW_ALL: RobotsRules = { isAllowed: () => true };
const DENY_ALL: RobotsRules = { isAllowed: () => false };

function uaToken(value: string): string {
  const lower = value.trim().toLowerCase();
  const idx = lower.search(/[\s/]/);
  return idx === -1 ? lower : lower.slice(0, idx);
}

export function parseRobotsTxt(body: string): RobotsRules {
  const rulesByUa = new Map<string, Rule[]>();
  let pendingUas: string[] = [];
  let lastDirectiveWasUA = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const directive = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (directive === "user-agent") {
      if (!lastDirectiveWasUA) pendingUas = [];
      const token = value === "*" ? "*" : uaToken(value);
      pendingUas.push(token);
      if (!rulesByUa.has(token)) rulesByUa.set(token, []);
      lastDirectiveWasUA = true;
      continue;
    }
    lastDirectiveWasUA = false;

    if (pendingUas.length === 0) continue;
    if (directive !== "disallow" && directive !== "allow") continue;
    const rule: Rule = { allow: directive === "allow", path: value };
    for (const ua of pendingUas) rulesByUa.get(ua)?.push(rule);
  }

  if (rulesByUa.size === 0) return ALLOW_ALL;

  return {
    isAllowed(path: string, userAgent: string): boolean {
      const name = uaToken(userAgent);
      const rules = rulesByUa.get(name) ?? rulesByUa.get("*");
      if (!rules) return true;
      let bestLen = -1;
      let bestAllow = true;
      for (const rule of rules) {
        if (rule.path === "") continue;
        if (path.startsWith(rule.path)) {
          if (rule.path.length > bestLen) {
            bestLen = rule.path.length;
            bestAllow = rule.allow;
          } else if (rule.path.length === bestLen && rule.allow) {
            bestAllow = true;
          }
        }
      }
      return bestLen === -1 ? true : bestAllow;
    },
  };
}

interface CacheEntry {
  readonly rules: RobotsRules;
  readonly expiresAt: number;
}

export interface RobotsTxtCacheOptions {
  readonly fetchFn?: typeof globalThis.fetch;
  readonly clock?: () => number;
  readonly ttlMs?: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class RobotsTxtCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<CacheEntry>>();
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly clock: () => number;
  private readonly ttlMs: number;

  constructor(opts: RobotsTxtCacheOptions = {}) {
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.clock = opts.clock ?? Date.now;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  async isAllowed(url: string, userAgent: string): Promise<boolean> {
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error(`robots.txt cache only supports http(s); got ${target.protocol}`);
    }
    const origin = target.origin;
    const now = this.clock();
    let entry = this.entries.get(origin);
    if (!entry || entry.expiresAt <= now) {
      entry = await this.load(origin, now);
    }
    return entry.rules.isAllowed(target.pathname + target.search, userAgent);
  }

  private async load(origin: string, now: number): Promise<CacheEntry> {
    const existing = this.inflight.get(origin);
    if (existing) return existing;
    const promise = this.fetchAndParse(origin, now);
    this.inflight.set(origin, promise);
    try {
      const entry = await promise;
      this.entries.set(origin, entry);
      return entry;
    } finally {
      this.inflight.delete(origin);
    }
  }

  private async fetchAndParse(origin: string, now: number): Promise<CacheEntry> {
    const expiresAt = now + this.ttlMs;
    try {
      const res = await this.fetchFn(`${origin}/robots.txt`);
      if (res.status >= 500) {
        return { rules: DENY_ALL, expiresAt };
      }
      if (res.status === 404 || res.status === 410) {
        return { rules: ALLOW_ALL, expiresAt };
      }
      const body = await res.text();
      return { rules: parseRobotsTxt(body), expiresAt };
    } catch {
      return { rules: DENY_ALL, expiresAt };
    }
  }
}
