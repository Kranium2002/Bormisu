# Web image: the frontend built in API mode, served by nginx with the /api proxy.
# Build from the repository root, so the shared DIN 4023 assets are in the context:
#   docker build -f frontend/Dockerfile .
# Context filter: frontend/Dockerfile.dockerignore (BuildKit reads it next to this file).

# ---- stage 1: build ----
FROM node:22-alpine AS build
WORKDIR /app/frontend

# Dependencies first, so source changes reuse this layer.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

# Same relative layout as the repository: vite.config.ts aliases @din to ../assets/din4023_patterns.
COPY assets/din4023_patterns/ /app/assets/din4023_patterns/
COPY frontend/ ./

# Public build settings, written into the JavaScript (no secrets: the frontend has none).
# Empty values fall back to the defaults in src/config.ts.
ARG VITE_APP_NAME=""
ARG VITE_TILE_URL=""
ARG VITE_TILE_ATTRIBUTION=""
# Always API mode against the nginx proxy below; sample mode never ships.
ENV VITE_DATA_SOURCE=api \
    VITE_API_BASE=/api/v1 \
    VITE_APP_NAME=$VITE_APP_NAME \
    VITE_TILE_URL=$VITE_TILE_URL \
    VITE_TILE_ATTRIBUTION=$VITE_TILE_ATTRIBUTION

RUN npm run build && npm run check:dist

# ---- stage 2: serve ----
FROM nginx:1.30.6-alpine

# frontend/nginx.conf is a template of the nginx image: at start, envsubst fills in the two
# variables below (and only those) and writes /etc/nginx/conf.d/default.conf.
#   API_UPSTREAM  where /api goes: scheme, host and port, no path (compose service "api")
#   API_RESOLVER  DNS server that resolves it per request (Docker's embedded DNS)
ENV API_UPSTREAM=http://api:8000 \
    API_RESOLVER=127.0.0.11 \
    NGINX_ENVSUBST_FILTER='^API_(UPSTREAM|RESOLVER)$'

# Replace the image's default site and its sample pages.
RUN rm -rf /etc/nginx/conf.d/default.conf /usr/share/nginx/html/*
COPY frontend/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/frontend/dist /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
