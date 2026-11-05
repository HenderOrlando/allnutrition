FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY scripts/install.mjs ./scripts/install.mjs
RUN node scripts/install.mjs
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM build AS checks
# Native media/browser contracts run here, never in the application image.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && ./node_modules/.bin/playwright install --with-deps chromium && chmod -R a+rX /ms-playwright && rm -rf /var/lib/apt/lists/*

FROM build AS production-deps
# Production Chromium stays in Dockerfile.social-browser; the app keeps the signed client dependency.
RUN npm prune --omit=dev --legacy-peer-deps

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=production-deps --chown=node:node /app /app
RUN mkdir -p /app/data/product-images /app/data/social-media /app/backups && chown -R node:node /app/data /app/backups && chmod 700 /app/data /app/data/product-images /app/data/social-media /app/backups
USER node
EXPOSE 3000
CMD ["node","node_modules/next/dist/bin/next","start","--hostname","0.0.0.0"]
