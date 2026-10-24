# syntax=docker/dockerfile:1
# Builds any app on @lunega/app. CI runs it with the app's repo as the context.
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
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
ENTRYPOINT ["node", "--enable-source-maps", "node_modules/@lunega/app/dist/cli.js"]
