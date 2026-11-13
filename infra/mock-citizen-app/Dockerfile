# Reference citizen folder (MT-07). Built from the repository root:
#   docker build -f infra/mock-citizen-app/Dockerfile .
FROM node:24.22.1-alpine3.24
RUN npm install --global pnpm@11.15.0 && apk add --no-cache wget
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm exec turbo run build --filter=@rid/mock-citizen-app...
ENV NODE_ENV=production
RUN mkdir -p /repo/infra/mock-citizen-app/data && chown node /repo/infra/mock-citizen-app/data
USER node
WORKDIR /repo/infra/mock-citizen-app
EXPOSE 3100
HEALTHCHECK --interval=10s --timeout=5s --retries=30 --start-period=20s   CMD wget -q -O /dev/null http://127.0.0.1:3100/health || exit 1
CMD ["node", "dist/main.js"]
