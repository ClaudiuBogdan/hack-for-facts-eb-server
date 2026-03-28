# =============================================================================
# Dockerfile - Transparenta.eu API Server
# =============================================================================
# Multi-stage build for a minimal production image
#
# SECURITY FEATURES:
# - Distroless runtime image (no shell, npm, or pnpm in production)
# - Non-root runtime user (distroless `nonroot`)
# - Build tools excluded from the final image
# - Production dependencies installed in a dedicated stage
#
# EFFICIENCY FEATURES:
# - BuildKit cache mounts for pnpm
# - Dependency and build stages reuse the same package-manager cache
# - Runtime image only copies the assets required to boot the API
# =============================================================================

ARG NODE_BUILD_BASE=node:24-trixie-slim@sha256:c319bb4fac67c01ced508b67193a0397e02d37555d8f9b72958649efd302b7f8
ARG DISTROLLESS_BASE=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:924918584d0e6793e578fc0e98b8b8026ae4ac2ccf2fea283bc54a7165441ccd

# -----------------------------------------------------------------------------
# Build Stage
# -----------------------------------------------------------------------------
FROM ${NODE_BUILD_BASE} AS builder

WORKDIR /app

# Install the pinned pnpm version used by CI and local development
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# Copy only the files required to resolve and build the application
COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json ./

# Install full dependency graph for the TypeScript build without lifecycle hooks
RUN --mount=type=cache,id=pnpm-bookworm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# Copy application source explicitly so .dockerignore is not the primary boundary
COPY src ./src

# Build TypeScript application
RUN pnpm build

# -----------------------------------------------------------------------------
# Production Dependencies Stage
# -----------------------------------------------------------------------------
FROM ${NODE_BUILD_BASE} AS prod-deps

WORKDIR /app

# Install the same pinned pnpm version for deterministic production deps
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# Copy package files only; runtime dependencies do not need the source tree
COPY package.json pnpm-lock.yaml ./

# Install production dependencies without executing install scripts
RUN --mount=type=cache,id=pnpm-bookworm,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile --ignore-scripts

# -----------------------------------------------------------------------------
# Runtime Stage
# -----------------------------------------------------------------------------
FROM ${DISTROLLESS_BASE}

WORKDIR /app

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose application port
EXPOSE 3000

# HEALTH CHECK: Docker-native health check for standalone usage
# Uses /health/live endpoint (simple liveness check)
# Distroless images require exec-form health checks because there is no shell.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/nodejs/bin/node", "-e", "fetch('http://localhost:3000/health/live').then((response)=>process.exit(response.ok ? 0 : 1)).catch(()=>process.exit(1))"]

# OCI Image Labels for traceability
# These are populated by CI/CD pipeline via --build-arg
ARG BUILD_DATE
ARG VCS_REF
ARG VERSION

LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.title="Transparenta.eu API" \
      org.opencontainers.image.description="Budget transparency API server" \
      org.opencontainers.image.vendor="Transparenta.eu" \
      org.opencontainers.image.source="https://github.com/ClaudiuBogdan/hack-for-facts-eb-server"

# Copy the minimal runtime payload. package.json is kept for ESM module mode.
COPY --from=prod-deps --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=builder --chown=65532:65532 /app/dist ./dist
COPY --from=builder --chown=65532:65532 /app/package.json ./package.json
COPY --chown=65532:65532 datasets ./datasets

# Run the application using the distroless image's Node.js entrypoint
CMD ["dist/api.js"]
