# syntax=docker/dockerfile:1
# Builds any app on @lunega-dev/app. CI runs it with the app's repo as the
# context, passing an .npmrc that carries a read:packages token as the "npmrc"
# build secret (the repo's own .npmrc maps @lunega-dev to GitHub Packages).
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci
COPY . .
RUN npm run build --if-present && npm prune --omit=dev

FROM node:${NODE_VERSION}-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app /app
# Single port, so Traefik picks it up without a service label.
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/__health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# node itself, not npm run: signals reach the app, so docker stop is instant.
ENTRYPOINT ["node", "--enable-source-maps", "node_modules/@lunega-dev/app/dist/cli.js"]
