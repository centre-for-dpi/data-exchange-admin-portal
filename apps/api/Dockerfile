# Portal API image. Built from the repo root:
#   docker build -f apps/api/Dockerfile .
# The default command applies pending migrations as the schema owner (DATABASE_MIGRATION_URL),
# loads the idempotent seed when DEN_ALLOW_SEED=true (pilots) and serves on API_PORT (4000). The
# Helm chart runs the migrations in their own Job and only the server here.

# --- Build: the whole workspace, then the API with its production dependencies only. ---
FROM node:24.22.1-alpine3.24 AS build
RUN npm install --global pnpm@11.15.0
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm exec turbo run build --filter=@den/api \
 && pnpm --filter @den/api deploy --prod --legacy /out \
 && rm -rf /out/dist && cp -r apps/api/dist /out/dist

# --- Runtime: no compilers, no dev dependencies and no package manager (M6-05). ---
FROM node:24.22.1-alpine3.24
# npm, npx, corepack and yarn ship in the base image; nothing installs packages here.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
# The repo layout the API reads at run time: the country configuration, the OPA policies it
# serves as a bundle and, for the pilot seed, the development realm (pnpm-workspace.yaml marks
# the root it walks up to).
WORKDIR /repo
COPY pnpm-workspace.yaml ./
COPY config ./config
COPY packages/policy/den ./packages/policy/den
COPY infra/keycloak/den-portal-realm.json ./infra/keycloak/
COPY --from=build /out ./apps/api
# Uploaded documents (DEN_DOCUMENTS_DIR); a named volume mounted here keeps this owner.
RUN mkdir -p /var/lib/den/documents && chown node /var/lib/den/documents
ENV NODE_ENV=production DEN_DOCUMENTS_DIR=/var/lib/den/documents
USER node
WORKDIR /repo/apps/api
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=5s --retries=30 --start-period=60s \
  CMD wget -q -O /dev/null http://127.0.0.1:4000/api/v1/health || exit 1
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && if [ \"$DEN_ALLOW_SEED\" = true ]; then node --enable-source-maps dist/seed/main.js; fi && exec node --enable-source-maps dist/main.js"]
