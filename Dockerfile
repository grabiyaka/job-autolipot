FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

FROM base AS build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
WORKDIR /app
COPY server ./server
COPY client ./client
RUN npm --prefix server run db:generate && npm --prefix server run check
RUN npm --prefix client run check

FROM base AS runtime
WORKDIR /app/server
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/server/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/dist ./dist
COPY --from=build --chown=node:node /app/server/prisma ./prisma
COPY --from=build --chown=node:node /app/server/prisma.config.ts ./prisma.config.ts
COPY --from=build --chown=node:node /app/server/package.json ./package.json
COPY --from=build --chown=node:node /app/client/dist /app/client/dist
RUN mkdir -p /app/server/data && chown node:node /app/server/data
USER node
EXPOSE 3400
CMD ["sh", "-c", "npm run db:migrate && node dist/server.js"]
