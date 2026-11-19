# Built from the repository root: docker build -f infra/mock-providers/Dockerfile .
FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
RUN npm install --global pnpm@11.15.0 && apk add --no-cache wget
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @den/mock-providers \
 && pnpm --filter @den/mock-providers build
ENV NODE_ENV=production
USER node
WORKDIR /repo/infra/mock-providers
CMD ["node", "dist/main.js"]
