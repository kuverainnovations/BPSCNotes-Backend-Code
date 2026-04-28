# ════════════════════════════════════════════════════════════
# Stage 1 — Build
# ════════════════════════════════════════════════════════════
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm ci --legacy-peer-deps

# Copy source and build
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# ════════════════════════════════════════════════════════════
# Stage 2 — Production image
# ════════════════════════════════════════════════════════════
FROM node:20-alpine AS production

# Security: run as non-root
RUN addgroup -g 1001 -S nodejs && \
    adduser  -S nestjs -u 1001

WORKDIR /app

# Copy built artifacts
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/dist         ./dist
COPY --from=builder --chown=nestjs:nodejs /app/package.json ./package.json

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:5000/health || exit 1

USER nestjs

EXPOSE 5000

ENV NODE_ENV=production

CMD ["node", "dist/main"]
