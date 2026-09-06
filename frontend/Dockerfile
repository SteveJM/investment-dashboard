# Investment Dashboard - frontend
#
# Multi-stage build: compile the React/Vite app to static assets, then serve
# them with nginx, which also reverse-proxies /api/ to the service container
# and injects the shared API key server-side (see nginx/default.conf.template
# and src/api/client.ts) so the key never ships in the browser bundle.

FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig*.json vite.config.ts index.html ./
COPY src ./src
# VITE_API_BASE_URL / VITE_API_KEY are intentionally left unset for this
# build - the app falls back to same-origin relative /api/... requests,
# which nginx proxies (see nginx/default.conf.template).
RUN npm run build

FROM nginx:1.27-alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template

# Defaults match docker-compose.yml's service names/ports; override at
# `docker run`/compose time (e.g. a stronger API_KEY in production).
ENV SERVICE_HOST=service \
    SERVICE_PORT=4000 \
    API_KEY=devkey

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
