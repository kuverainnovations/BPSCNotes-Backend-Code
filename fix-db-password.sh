#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════
# fix-db-password.sh
#
# Run this ONCE when you see "password authentication failed"
# after changing DB_PASSWORD in .env.
#
# What it does:
#   1. Connects to postgres as the postgres superuser
#   2. Updates the role password to match .env
#
# Usage: bash fix-db-password.sh
# ════════════════════════════════════════════════════════════
set -euo pipefail

[[ -f ".env" ]] || { echo "ERROR: .env not found"; exit 1; }

DB_USER=$(grep "^DB_USER=" .env | cut -d= -f2-)
DB_PASS=$(grep "^DB_PASSWORD=" .env | cut -d= -f2-)
DB_NAME=$(grep "^DB_NAME=" .env | cut -d= -f2-)

echo "Fixing password for user: $DB_USER on db: $DB_NAME"

# Connect using the postgres superuser (bypasses password auth)
docker-compose exec -T postgres psql -U postgres << SQL
-- Update the application user's password to match .env
ALTER USER "${DB_USER}" WITH PASSWORD '${DB_PASS}';

-- Verify
SELECT usename, usesuper FROM pg_user WHERE usename = '${DB_USER}';
SQL

echo ""
echo "✅ Password updated. Now restart the API:"
echo "   docker-compose restart api"
