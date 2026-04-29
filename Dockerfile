# syntax=docker/dockerfile:1.7
#
# openroles — static site image
# Stage 1 builds the Astro site with Bun.
# Stage 2 serves dist/ via nginx with HTTP range requests for sql.js-httpvfs.

FROM oven/bun:1.3-alpine AS build
WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY shared/package.json shared/
COPY scraper/package.json scraper/
COPY site/package.json site/
RUN bun install --frozen-lockfile

COPY shared/ shared/
COPY scraper/ scraper/
COPY site/ site/

RUN bun run build

FROM nginx:1.27-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/site/dist/ /usr/share/nginx/html/openroles/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O - http://localhost/openroles/ >/dev/null || exit 1
