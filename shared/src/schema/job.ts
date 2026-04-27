import { z } from "zod";
import { ATSIdSchema } from "./ats.ts";
import { LEVEL_RANK, LevelSchema } from "./level.ts";
import { HttpUrl } from "./url.ts";
import { WorkplaceTypeSchema } from "./workplace.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejects control chars in user-facing fields
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

const NonEmptyTrimmed = z
  .string()
  .min(1)
  .max(1024)
  .refine((s) => s.trim().length > 0, "must contain non-whitespace")
  .refine((s) => !CONTROL_CHAR_RE.test(s), "must not contain control characters");

const ShortText = z
  .string()
  .max(2048)
  .refine((s) => !CONTROL_CHAR_RE.test(s), "must not contain control characters");

const ExcerptText = z
  .string()
  .max(4096)
  .refine((s) => s.trim().length > 0, "must contain non-whitespace")
  .refine((s) => !CONTROL_CHAR_RE.test(s), "must not contain control characters");

const HexId = z.string().regex(/^[0-9a-f]{64}$/, "must be 64-char lowercase hex");

const IsoUtc = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
    "must be ISO 8601 UTC with trailing Z",
  );

const Iso4217 = z.string().regex(/^[A-Z]{3}$/, "must be ISO 4217 (3 uppercase letters)");

const Iso3166Alpha2 = z.string().regex(/^[A-Z]{2}$/, "must be ISO 3166-1 alpha-2");

const Slug = z
  .string()
  .regex(/^[a-z0-9-]+$/, "must match [a-z0-9-]+")
  .min(1)
  .max(64);

const COMPENSATION_MAX = 1_000_000_000_00;

export const JobSchema = z
  .object({
    id: HexId,
    ats: ATSIdSchema,
    tenant_slug: Slug,
    source_id: NonEmptyTrimmed,
    title: NonEmptyTrimmed,
    company: NonEmptyTrimmed,
    description_excerpt: ExcerptText.optional(),
    level: LevelSchema,
    level_rank: z.union([z.int().min(0).max(9), z.null()]),
    workplace_type: WorkplaceTypeSchema,
    is_recruiter_post: z.boolean(),
    location_text: ShortText.optional(),
    location_country: Iso3166Alpha2.optional(),
    location_region: ShortText.optional(),
    compensation_min: z.int().nonnegative().max(COMPENSATION_MAX).optional(),
    compensation_max: z.int().nonnegative().max(COMPENSATION_MAX).optional(),
    compensation_currency: Iso4217.optional(),
    department: ShortText.optional(),
    posted_at: IsoUtc.optional(),
    updated_at: IsoUtc.optional(),
    first_seen_at: IsoUtc,
    last_seen_at: IsoUtc,
    url: HttpUrl,
  })
  .superRefine((job, ctx) => {
    if (job.level === null) {
      if (job.level_rank !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["level_rank"],
          message: "must be null when level is null",
        });
      }
    } else {
      const expected = LEVEL_RANK[job.level];
      if (job.level_rank !== expected) {
        ctx.addIssue({
          code: "custom",
          path: ["level_rank"],
          message: `must equal LEVEL_RANK[${job.level}] (${expected})`,
        });
      }
    }

    if (
      job.compensation_min !== undefined &&
      job.compensation_max !== undefined &&
      job.compensation_min > job.compensation_max
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["compensation_min"],
        message: "must be <= compensation_max",
      });
    }

    if (job.posted_at !== undefined && job.posted_at > job.last_seen_at) {
      ctx.addIssue({
        code: "custom",
        path: ["posted_at"],
        message: "must be <= last_seen_at",
      });
    }

    if (job.updated_at !== undefined && job.updated_at > job.last_seen_at) {
      ctx.addIssue({
        code: "custom",
        path: ["updated_at"],
        message: "must be <= last_seen_at",
      });
    }

    if (job.first_seen_at > job.last_seen_at) {
      ctx.addIssue({
        code: "custom",
        path: ["first_seen_at"],
        message: "must be <= last_seen_at",
      });
    }
  });

export type Job = z.infer<typeof JobSchema>;
