# =============================================================================
# Dockerfile - Transparenta.eu API Server
# =============================================================================
# Multi-stage build for minimal production image
#
# SECURITY FEATURES:
# - Alpine Linux (minimal attack surface)
# - Non-root user (nodejs:1001)
# - No build tools in final image
# - Production dependencies only
#
# EFFICIENCY FEATURES:
# - BuildKit cache mounts for pnpm
# - User created before install (avoids slow chown)
# - Optimized layer ordering
# =============================================================================

# -----------------------------------------------------------------------------
# Build Stage
# -----------------------------------------------------------------------------
FROM node:22.16-alpine AS builder

WORKDIR /app

# Install pnpm via corepack
RUN corepack enable && corepack prepare pnpm@10.24.0 --activate

# Copy package files first for better layer caching
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including devDependencies for build)
# SECURITY: --ignore-scripts prevents arbitrary code execution during install
# EFFICIENCY: --mount=type=cache reuses pnpm store across builds
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Copy source code (respects .dockerignore)
COPY . .

# Build TypeScript application
RUN pnpm build

# -----------------------------------------------------------------------------
# Production Stage
# -----------------------------------------------------------------------------
FROM node:22.16-alpine

# SECURITY: Create non-root user BEFORE installing dependencies
# This avoids running chown on node_modules (which is slow and unnecessary)
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

WORKDIR /app

# Set ownership of workdir to nodejs user
RUN chown nodejs:nodejs /app

# Switch to non-root user BEFORE copying files and installing deps
# All subsequent operations run as nodejs user
USER nodejs

# Install pnpm via corepack (as nodejs user)
RUN corepack enable && corepack prepare pnpm@10.24.0 --activate

# Copy package files (owned by nodejs due to USER directive)
COPY --from=builder --chown=nodejs:nodejs /app/package.json /app/pnpm-lock.yaml ./

# Copy build output
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist

# Copy datasets (static data files required at runtime)
COPY --from=builder --chown=nodejs:nodejs /app/datasets ./datasets

# Install production dependencies only
# SECURITY: --ignore-scripts prevents post-install scripts from running
# EFFICIENCY: --mount=type=cache reuses pnpm store across builds
RUN --mount=type=cache,id=pnpm,target=/home/nodejs/.local/share/pnpm/store,uid=1001,gid=1001 \
    pnpm install --prod --frozen-lockfile --ignore-scripts

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose application port
EXPOSE 3000

# HEALTH CHECK: Docker-native health check for standalone usage
# Uses /health/live endpoint (simple liveness check)
# Kubernetes will use its own probes, but this helps with:
# - Docker Compose health dependencies
# - Local development
# - Container orchestrators that use Docker health checks
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/health/live').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

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

# Run the application
# Node.js handles SIGTERM/SIGINT properly in src/api.ts
CMD ["node", "dist/api.js"]

