# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/server/package.json packages/server/package.json
RUN npm ci

COPY tsconfig.json tsconfig.base.json ./
COPY packages/protocol/tsconfig.json packages/protocol/tsconfig.json
COPY packages/server/tsconfig.json packages/server/tsconfig.json
COPY packages/protocol/src packages/protocol/src
COPY packages/server/src packages/server/src
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/server/package.json packages/server/package.json
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY qualification/reports/v0.0a-local.json qualification/reports/v0.0a-local.json
COPY qualification/capabilities/capabilities.json qualification/capabilities/capabilities.json
RUN chmod -R a+rX /app

USER node
ENTRYPOINT ["node", "packages/server/dist/index.js"]
