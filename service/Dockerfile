# Investment Dashboard - service tier (REST API + MCP server)
#
# Multi-stage build: compile TypeScript in a builder stage, ship only the
# compiled JS + production node_modules in the final image.

FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

# REST API and MCP server ports (see src/config.ts)
EXPOSE 4000 4001

# Basic container-level health check against the REST API. The MCP port
# doesn't have a plain GET health route (it's JSON-RPC only), so we check
# the REST side, which starts after the DB connectivity check succeeds.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

USER node
CMD ["node", "dist/index.js"]
