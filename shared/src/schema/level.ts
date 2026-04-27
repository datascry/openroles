import { z } from "zod";

const NON_NULL_LEVELS = [
  "intern",
  "entry",
  "junior",
  "mid",
  "senior",
  "staff",
  "principal",
  "lead",
  "manager",
  "director",
] as const;

export const LEVELS = Object.freeze([...NON_NULL_LEVELS, null] as const);

export type Level = (typeof NON_NULL_LEVELS)[number] | null;

export const LevelSchema = z.union([z.enum([...NON_NULL_LEVELS]), z.null()]);

export const LEVEL_RANK: Record<(typeof NON_NULL_LEVELS)[number], number> = {
  intern: 0,
  entry: 1,
  junior: 2,
  mid: 3,
  senior: 4,
  staff: 5,
  principal: 6,
  lead: 7,
  manager: 8,
  director: 9,
};

export function levelRank(level: Level): number | null {
  return level === null ? null : LEVEL_RANK[level];
}
