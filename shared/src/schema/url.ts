import { z } from "zod";

// HTTP(S)-only URL refinement. Closes the `javascript:` / `data:` URL XSS class
// for any field rendered into <a href="...">. Phase 7 audit caught this for
// Tenant.homepage_url; Phase 8 audit caught the same class on Job.url.
export const HttpUrl = z
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "must use http or https scheme");
