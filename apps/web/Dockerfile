# Portal web image (pilots and demos; the production topology is M6). Built from the repo root:
#   docker build -f apps/web/Dockerfile .
# Configuration comes from the environment at run time (AUTH_URL, KEYCLOAK_URL, RID_API_URL…).
FROM node:24.22.1-alpine3.24
RUN npm install --global pnpm@11.15.0 && apk add --no-cache wget
WORKDIR /repo
COPY . .
# The Auth.js config reads the client secret when a module loads, also while Next collects page
# data: a placeholder for the build only. The real one comes from the environment at run time.
RUN pnpm install --frozen-lockfile \
 && pnpm exec turbo run build --filter=@rid/web^... \
 && cd apps/web \
 && RID_PORTAL_WEB_CLIENT_SECRET=build-time-placeholder AUTH_SECRET=build-time-placeholder pnpm build
ENV NODE_ENV=production
USER node
WORKDIR /repo/apps/web
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --retries=30 --start-period=30s \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/ || exit 1
CMD ["node_modules/.bin/next", "start", "--port", "3000"]
