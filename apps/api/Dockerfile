# Portal API image. Built from the repo root:
#   docker build -f apps/api/Dockerfile .
# The default command loads the idempotent seed when DEN_ALLOW_SEED=true (pilots) and serves on
# API_PORT (4000), as den_app (DATABASE_URL). Migrations run apart, as the schema owner, with
# `node_modules/.bin/prisma migrate deploy` and DATABASE_MIGRATION_URL: the pilot's `migrate`
# service, the Helm chart's init container (A-2). The API container never gets the owner's password.

# --- Build: the whole workspace, then the API with its production dependencies only. ---
FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
RUN npm install --global pnpm@11.15.0
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm exec turbo run build --filter=@den/api \
 && pnpm --filter @den/api deploy --prod --legacy /out \
 && rm -rf /out/dist && cp -r apps/api/dist /out/dist

# --- Runtime: no compilers, no dev dependencies and no package manager (M6-05). ---
FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
# npm, npx, corepack and yarn ship in the base image; nothing installs packages here.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
# The repo layout the API reads at run time: the country configuration, the OPA policies it
# serves as a bundle and, for the pilot seed, the development realm (pnpm-workspace.yaml marks
# the root it walks up to).
WORKDIR /repo
COPY pnpm-workspace.yaml ./
# The example values, so the API refuses to start with one of them as a secret (M-25).
COPY .env.example ./
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
CMD ["sh", "-c", "if [ \"$DEN_ALLOW_SEED\" = true ]; then node --enable-source-maps dist/seed/main.js; fi && exec node --enable-source-maps dist/main.js"]
