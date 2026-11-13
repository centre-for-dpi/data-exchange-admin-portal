# Portal API image (pilots and demos; the production topology is M6). Built from the repo root:
#   docker build -f apps/api/Dockerfile .
# On start it applies pending migrations as the schema owner (DATABASE_MIGRATION_URL), loads the
# idempotent seed when RID_ALLOW_SEED=true, and serves on API_PORT (4000).
FROM node:24.22.1-alpine3.24
RUN npm install --global pnpm@11.15.0 && apk add --no-cache wget
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm exec turbo run build --filter=@rid/api
ENV NODE_ENV=production
USER node
WORKDIR /repo/apps/api
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=5s --retries=30 --start-period=60s \
  CMD wget -q -O /dev/null http://127.0.0.1:4000/api/v1/health || exit 1
CMD ["sh", "-c", "pnpm db:deploy && if [ \"$RID_ALLOW_SEED\" = true ]; then pnpm db:seed; fi && exec node --enable-source-maps dist/main.js"]
