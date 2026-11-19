# Portal web image. Built from the repo root:
#   docker build -f apps/web/Dockerfile .
# Configuration comes from the environment at run time (AUTH_URL, KEYCLOAK_URL, DEN_API_URL…).

# --- Build: the whole workspace, then the web with its production dependencies only. ---
FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
RUN npm install --global pnpm@11.15.0
WORKDIR /repo
COPY . .
# The Auth.js config reads the client secret when a module loads, also while Next collects page
# data: a placeholder for the build only. The real one comes from the environment at run time.
RUN pnpm install --frozen-lockfile \
 && pnpm exec turbo run build --filter=@den/web^... \
 && cd apps/web \
 && DEN_PORTAL_WEB_CLIENT_SECRET=build-time-placeholder AUTH_SECRET=build-time-placeholder pnpm build \
 && cd /repo \
 && pnpm --filter @den/web deploy --prod --legacy /out \
 && rm -rf /out/.next && cp -r apps/web/.next /out/.next && rm -rf /out/.next/cache

# --- Runtime: no compilers, no dev dependencies and no package manager (M6-05). ---
FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
# npm, npx, corepack and yarn ship in the base image; nothing installs packages here.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
# The country configuration (texts, branding) is read at run time from the repo layout.
WORKDIR /repo
COPY pnpm-workspace.yaml ./
# The example values, so the web refuses to start with one of them as a secret (M-25).
COPY .env.example ./
COPY config ./config
# /files/entity-check.sh (P-05) is made at build time from this file; the copy lets the route
# read it at run time too, should Next.js ever render it again.
COPY scripts/entity-check.sh ./scripts/entity-check.sh
COPY --from=build /out ./apps/web
ENV NODE_ENV=production
USER node
WORKDIR /repo/apps/web
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --retries=30 --start-period=30s \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/auth/providers || exit 1
CMD ["node_modules/.bin/next", "start", "--port", "3000"]
