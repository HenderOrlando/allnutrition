FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY scripts/install.mjs ./scripts/install.mjs
RUN node scripts/install.mjs
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM build AS production-deps
# Next declares Playwright as an optional peer; it belongs only in the build image.
RUN npm prune --omit=dev --legacy-peer-deps

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=production-deps --chown=node:node /app /app
RUN mkdir -p /app/data/product-images /app/backups && chown -R node:node /app/data /app/backups && chmod 700 /app/data /app/data/product-images /app/backups
USER node
EXPOSE 3000
CMD ["node","node_modules/next/dist/bin/next","start","--hostname","0.0.0.0"]
