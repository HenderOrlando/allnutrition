FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY scripts/install.mjs ./scripts/install.mjs
RUN node scripts/install.mjs
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /app/data /app/backups && chown -R node:node /app/data /app/backups && chmod 700 /app/data /app/backups
USER node
EXPOSE 3000
CMD ["npm","start"]
