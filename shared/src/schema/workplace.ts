import { z } from "zod";

export const WORKPLACE_TYPES = Object.freeze(["remote", "hybrid", "onsite"] as const);

export type WorkplaceType = (typeof WORKPLACE_TYPES)[number] | null;

export const WorkplaceTypeSchema = z.union([z.enum([...WORKPLACE_TYPES]), z.null()]);
