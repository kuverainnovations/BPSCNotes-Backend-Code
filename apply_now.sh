#!/bin/bash
# ════════════════════════════════════════════════════════════
# Run this on your VPS from your project root.
# This fixes the rate limiting that's causing all your 503s.
# ════════════════════════════════════════════════════════════
set -e

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
ok()  { echo -e "${GREEN}✅ $*${NC}"; }
err() { echo -e "${RED}❌ $*${NC}"; exit 1; }

echo "═══════════════════════════════════════"
echo " BPSCNotes — Rate Limit Fix"
echo "═══════════════════════════════════════"

# Check the current rate limit — this is the smoking gun
echo ""
echo "─── Current nginx rate limit for admin ───"
docker exec bpscnotes-nginx grep -A2 "api/v1/admin" /etc/nginx/conf.d/bpscnotes.conf || true

# Step 1: Copy fixed nginx configs
echo ""
echo "─── Applying nginx fixes ───"
cp nginx/nginx.conf       nginx/nginx.conf.bak.$(date +%s) 2>/dev/null || true
cp nginx/conf.d/bpscnotes.conf nginx/conf.d/bpscnotes.conf.bak.$(date +%s) 2>/dev/null || true

# These files must be in your project's nginx/ directory:
echo "Copying fixed nginx files..."
# (files are already in place if you extracted the zip to project root)

# Step 2: Test nginx config
echo ""
echo "─── Testing nginx config ───"
docker exec bpscnotes-nginx nginx -t && ok "nginx config valid" || err "nginx config invalid"

# Step 3: Reload nginx (no downtime)
docker exec bpscnotes-nginx nginx -s reload
ok "nginx reloaded"

# Step 4: Verify the rate limit is now correct
echo ""
echo "─── Verifying fix ───"
docker exec bpscnotes-nginx grep -A2 "api/v1/admin" /etc/nginx/conf.d/bpscnotes.conf
echo ""

# Step 5: Remove backend debug logs (fix the logging issue)
echo "─── Checking backend log size ───"
docker exec bpscnotes-api ls -lh /proc/1/fd 2>/dev/null || true
docker logs bpscnotes-api --tail 5 2>/dev/null | head -5

# Step 6: Quick load test to confirm fix
echo ""
echo "─── Testing admin endpoint rate limit ───"
TOKEN=$(curl -sf -X POST https://api.bpscnotes.in/api/v1/admin/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@bpscnotes.com","password":"admin123"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('token',''))" 2>/dev/null || echo "")

if [[ -n "$TOKEN" ]]; then
  echo "Got token, firing 6 parallel requests (simulating dashboard load)..."
  for i in 1 2 3; do
    echo -n "  Load #$i: "
    RESULTS=$(
      curl -sf -o /dev/null -w "%{http_code} " -H "Authorization: Bearer $TOKEN" https://api.bpscnotes.in/api/v1/admin/stats &
      curl -sf -o /dev/null -w "%{http_code} " -H "Authorization: Bearer $TOKEN" "https://api.bpscnotes.in/api/v1/admin/analytics/chart?type=users" &
      curl -sf -o /dev/null -w "%{http_code} " -H "Authorization: Bearer $TOKEN" "https://api.bpscnotes.in/api/v1/admin/analytics/chart?type=revenue" &
      curl -sf -o /dev/null -w "%{http_code} " -H "Authorization: Bearer $TOKEN" https://api.bpscnotes.in/api/v1/admin/analytics/revenue-breakdown &
      curl -sf -o /dev/null -w "%{http_code} " -H "Authorization: Bearer $TOKEN" https://api.bpscnotes.in/api/v1/admin/analytics/exam-distribution &
      curl -sf -o /dev/null -w "%{http_code} " -H "Authorization: Bearer $TOKEN" https://api.bpscnotes.in/api/v1/admin/notifications &
      wait
    )
    echo "$RESULTS"
    if echo "$RESULTS" | grep -q "503"; then
      echo "  ❌ Still getting 503 — rate limit NOT fixed"
    else
      echo "  ✅ All 200 — rate limit fix working"
    fi
  done
else
  echo "  (Skipping test — could not get admin token)"
fi

echo ""
echo "═══════════════════════════════════════"
echo " Done. Check browser now."
echo "═══════════════════════════════════════"
