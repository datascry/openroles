// @ts-check

import sitemap from "@astrojs/sitemap";
import svelte from "@astrojs/svelte";
import { defineConfig } from "astro/config";

// Site config — https://docs.astro.build/en/reference/configuration-reference/
export default defineConfig({
  site: "https://datascry.github.io",
  base: "/openroles",
  output: "static",
  trailingSlash: "ignore",
  integrations: [
    svelte(),
    // Generates /sitemap-index.xml + /sitemap-0.xml at build time, enumerating
    // every static route. The data SQLite blob is excluded from the sitemap
    // by default since it's not an HTML page.
    sitemap({
      changefreq: "daily",
      priority: 0.7,
      lastmod: new Date(),
    }),
  ],
  build: {
    inlineStylesheets: "auto",
  },
  prefetch: {
    prefetchAll: false,
    defaultStrategy: "viewport",
  },
});
