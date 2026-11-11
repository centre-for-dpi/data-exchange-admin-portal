# Built from the repository root: docker build -f infra/mock-providers/Dockerfile .
FROM node:24.22.1-alpine3.24
RUN npm install --global pnpm@11.15.0 && apk add --no-cache wget
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @rid/mock-providers \
 && pnpm --filter @rid/mock-providers build
ENV NODE_ENV=production
USER node
WORKDIR /repo/infra/mock-providers
CMD ["node", "dist/main.js"]
