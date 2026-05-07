#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════
# BPSCNotes — Production Deployment Script
# Run as: bash deploy.sh
# ════════════════════════════════════════════════════════════
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── 0. Pre-flight checks ──────────────────────────────────────
info "Running pre-flight checks..."

[[ -f ".env" ]] || error ".env file not found. Copy .env.example and fill it in."

# Ensure required vars are set
for var in DB_USER DB_PASSWORD DB_NAME JWT_SECRET ADMIN_JWT_SECRET; do
  val=$(grep "^${var}=" .env | cut -d= -f2-)
  [[ -z "$val" ]] && error "$var is not set in .env"
  [[ "$val" == *"REPLACE_WITH"* ]] && error "$var still has placeholder value. Set a real value."
done

DB_USER=$(grep "^DB_USER=" .env | cut -d= -f2-)
DB_PASS=$(grep "^DB_PASSWORD=" .env | cut -d= -f2-)
DB_NAME=$(grep "^DB_NAME=" .env | cut -d= -f2-)

info "DB_USER=$DB_USER  DB_NAME=$DB_NAME"

# ── 1. Fix postgres password if volume exists with wrong password ──
# This is the root cause of "password authentication failed" on subsequent runs.
# Postgres stores the password in its data directory.
# If the container was first created with password A, changing .env to password B
# does NOT update postgres — you have to ALTER the role.

POSTGRES_RUNNING=$(docker-compose ps postgres --format json 2>/dev/null | grep '"State":"running"' || true)

if [[ -n "$POSTGRES_RUNNING" ]]; then
  info "Postgres is running. Syncing password to match .env..."
  docker-compose exec -T postgres psql -U "$DB_USER" -c \
    "ALTER USER \"${DB_USER}\" WITH PASSWORD '${DB_PASS}';" 2>/dev/null \
    || warn "Could not sync password (postgres may use old credentials — see manual fix below)"
fi

# ── 2. Build and start ────────────────────────────────────────
info "Building API image..."
docker-compose build --no-cache api

info "Starting all services..."
docker compose up -d

# ── 3. Wait for postgres to be healthy ───────────────────────
info "Waiting for PostgreSQL to be healthy..."
for i in $(seq 1 30); do
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' bpscnotes-postgres 2>/dev/null || echo "starting")
  if [[ "$STATUS" == "healthy" ]]; then
    info "PostgreSQL is healthy ✅"
    break
  fi
  [[ $i -eq 30 ]] && error "PostgreSQL did not become healthy after 60s. Check: docker logs bpscnotes-postgres"
  sleep 2
done

# ── 4. Wait for API to be healthy ────────────────────────────
info "Waiting for API to be healthy..."
for i in $(seq 1 40); do
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' bpscnotes-api 2>/dev/null || echo "starting")
  if [[ "$STATUS" == "healthy" ]]; then
    info "API is healthy ✅"
    break
  fi
  if [[ "$STATUS" == "unhealthy" ]]; then
    warn "API is unhealthy. Recent logs:"
    docker logs --tail=30 bpscnotes-api
    error "API failed to start. Fix the issue and re-run deploy.sh"
  fi
  [[ $i -eq 40 ]] && error "API did not become healthy after 80s"
  sleep 2
done

# ── 5. Verify DB credentials work ────────────────────────────
info "Verifying DB credentials..."
docker-compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1;" > /dev/null 2>&1 \
  && info "DB credentials OK ✅" \
  || error "DB credential check failed. Password in .env does not match postgres. Run fix-db-password.sh"

# ── 6. Run migrations ─────────────────────────────────────────
info "Running database migrations..."
docker-compose exec -T api node dist/database/migrate.js 2>/dev/null \
  || warn "Migration command failed or no migrate script. Ensure TypeORM migrationsRun:true in production."

# ── 7. Final status ───────────────────────────────────────────
echo ""
echo -e "${BOLD}════ Container Status ════${NC}"
docker-compose ps
echo ""
info "Deployment complete 🎉"
info "API:   https://api.bpscnotes.in/health"
info "Admin: https://admin.bpscnotes.in"
