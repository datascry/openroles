// @ts-check

import svelte from "@astrojs/svelte";
import { defineConfig } from "astro/config";

// Site config — https://docs.astro.build/en/reference/configuration-reference/
export default defineConfig({
  site: "https://datascry.github.io",
  base: "/openroles",
  output: "static",
  trailingSlash: "ignore",
  integrations: [svelte()],
  build: {
    inlineStylesheets: "auto",
  },
  prefetch: {
    prefetchAll: false,
    defaultStrategy: "viewport",
  },
});
