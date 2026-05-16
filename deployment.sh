#!/bin/bash
# ════════════════════════════════════════════════════════════
# Production Deployment Script
# Run on VPS: bash deployment.sh
#
# FIXES BUG 15: ensures NEXT_PUBLIC_API_URL is set BEFORE build
# FIXES BUG 14: uses PM2 ecosystem.config.js
# ════════════════════════════════════════════════════════════
set -euo pipefail

echo "═══════════════════════════════════════════"
echo " BPSCNotes Production Deployment"
echo "═══════════════════════════════════════════"

# ── 1. Backend ──────────────────────────────────────────────
echo "[1/4] Building backend..."
cd /var/www/api
npm ci --omit=dev
npm run build
pm2 reload ecosystem.config.js --env production --only bpscnotes-api
echo "✅ Backend deployed"

# ── 2. Admin Panel ──────────────────────────────────────────
echo "[2/4] Building admin panel..."
cd /var/www/admin

# BUG 15 FIX: NEXT_PUBLIC_API_URL MUST be set at build time.
# It gets baked into the JS bundle. Runtime env vars won't work for NEXT_PUBLIC_*.
export NEXT_PUBLIC_API_URL="https://api.bpscnotes.in/api/v1"
export NODE_ENV="production"

npm ci --omit=dev
npm run build
echo "✅ Admin built"

echo "[3/4] Restarting admin panel..."
pm2 reload ecosystem.config.js --env production --only bpscnotes-admin
echo "✅ Admin panel deployed"

# ── 3. Nginx reload (no downtime) ───────────────────────────
echo "[4/4] Reloading nginx..."
nginx -t && systemctl reload nginx
echo "✅ Nginx reloaded"

echo ""
echo "═══════════════════════════════════════════"
echo " Deployment complete!"
echo " Admin: https://admin.bpscnotes.in"
echo " API:   https://api.bpscnotes.in/health"
echo "═══════════════════════════════════════════"
pm2 list
