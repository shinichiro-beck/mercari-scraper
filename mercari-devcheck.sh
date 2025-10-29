#!/usr/bin/env bash
# mercari-devcheck.sh — Developer-mode harness for mercari-scraper API
# Usage:
#   chmod +x mercari-devcheck.sh
#   ./mercari-devcheck.sh -b "https://mercari-scraper-n509.onrender.com" -k "YOUR_64_CHAR_API_KEY"
#
# Flags:
#   -b, --base   Base URL (required)
#   -k, --key    x-api-key (required for protected endpoints)
#   --secure-health   Also call /health and /warmup with the API key
#   --skip-maker      Skip maker example calls
#   --no-key-check    Do not enforce 64-char key length check
#   -h, --help  Show help
#
set -euo pipefail

BASE=""
KEY=""
SECURE_HEALTH=0
SKIP_MAKER=0
NO_KEY_CHECK=0

MERCARI_URL_DEFAULT="https://jp.mercari.com/item/m39502307058"
MAKER_URL_DEFAULT="https://example.com/product/abc"

log() { printf "[%s] %s\n" "$(date '+%H:%M:%S')" "$*"; }
ok()  { printf "✅ %s\n" "$*"; }
warn(){ printf "⚠️  %s\n" "$*"; }
err() { printf "❌ %s\n" "$*" >&2; }

need() {
  command -v "$1" >/dev/null 2>&1 || { err "Required command '$1' not found"; exit 127; }
}

usage() {
  grep -E '^# ' "$0" | sed 's/^# //'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -b|--base) BASE="$2"; shift 2;;
    -k|--key) KEY="$2"; shift 2;;
    --secure-health) SECURE_HEALTH=1; shift;;
    --skip-maker) SKIP_MAKER=1; shift;;
    --no-key-check) NO_KEY_CHECK=1; shift;;
    -h|--help) usage; exit 0;;
    *) err "Unknown arg: $1"; usage; exit 2;;
  esac
done

need curl
need jq

if [[ -z "${BASE}" ]]; then err "Missing --base"; usage; exit 2; fi
if [[ -z "${KEY}" ]]; then err "Missing --key"; usage; exit 2; fi

if [[ $NO_KEY_CHECK -eq 0 ]]; then
  if [[ ${#KEY} -ne 64 ]]; then
    err "API key length is ${#KEY}, expected 64. Use --no-key-check to override."
    exit 2
  fi
fi

PASS=0; FAIL=0
pass(){ ok "$1"; PASS=$((PASS+1)); }
fail(){ err "$1"; FAIL=$((FAIL+1)); }

hr(){ printf -- "------------------------------------------------------------\n"; }

call() {
  local name="$1"; shift
  local http rc
  log "Calling: ${name}"
  set +e
  # shellcheck disable=SC2068
  http=$(curl -sS -o .resp.json -w "%{http_code}" "$@")
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    fail "${name}: curl failed (rc=$rc)"
    return 1
  fi
  if [[ "${http}" =~ ^[0-9]{3}$ ]]; then
    jq . < .resp.json || true
    echo "(HTTP ${http})"
  else
    warn "${name}: could not read HTTP status"; jq . < .resp.json || true
  fi
  rm -f .resp.json
  return 0
}

hr
log "Base: ${BASE}"
log "Key length: ${#KEY}"

hr
# 1) GET /
if call "root (GET /)" "${BASE}/"; then pass "root OK"; else fail "root NG"; fi

# 2) GET /health
hr
if [[ $SECURE_HEALTH -eq 1 ]]; then
  if call "healthCheck (GET /health, with key)" -H "x-api-key: ${KEY}" "${BASE}/health"; then pass "health (with key) OK"; else fail "health NG"; fi
else
  if call "healthCheck (GET /health, anon)" "${BASE}/health"; then pass "health (anon) OK"; else fail "health NG"; fi
fi

# 3) GET /warmup
hr
if [[ $SECURE_HEALTH -eq 1 ]]; then
  if call "warmup (GET /warmup, with key)" -H "x-api-key: ${KEY}" "${BASE}/warmup"; then pass "warmup (with key) OK"; else fail "warmup NG"; fi
else
  if call "warmup (GET /warmup, anon)" "${BASE}/warmup"; then pass "warmup (anon) OK"; else fail "warmup NG"; fi
fi

# 4) GET /scrape (guard 405)
hr
set +e
http=$(curl -sS -o /dev/null -w "%{http_code}" "${BASE}/scrape")
rc=$?
set -e
if [[ $rc -ne 0 ]]; then
  fail "scrapeGetGuard: curl failed (rc=$rc)"
elif [[ "$http" == "405" || "$http" == "404" ]]; then
  pass "scrapeGetGuard: 405 as expected"
else
  fail "scrapeGetGuard: expected 405, got ${http}"
fi

# 5) POST /scrape (mercari quick:true)
hr
if call "scrapeOne mercari quick:true" -X POST -H "Content-Type: application/json" -H "x-api-key: ${KEY}" \
  --data "{\"url\":\"${MERCARI_URL_DEFAULT}\",\"type\":\"mercari\",\"quick\":true}" \
  "${BASE}/scrape"; then pass "scrape mercari quick:true OK"; else fail "scrape mercari quick:true NG"; fi

# 6) POST /scrape (maker) — optional
if [[ $SKIP_MAKER -eq 0 ]]; then
  hr
  if call "scrapeOne maker" -X POST -H "Content-Type: application/json" -H "x-api-key: ${KEY}" \
    --data "{\"url\":\"${MAKER_URL_DEFAULT}\",\"type\":\"maker\"}" \
    "${BASE}/scrape"; then pass "scrape maker OK (or acceptable error if site blocks)"; else fail "scrape maker NG"; fi
fi

# 7) POST /scrape (mercari directOnly debug)
hr
if call "scrapeOne mercari directOnly" -X POST -H "Content-Type: application/json" -H "x-api-key: ${KEY}" \
  --data "{\"url\":\"${MERCARI_URL_DEFAULT}\",\"type\":\"mercari\",\"quick\":true,\"directOnly\":true}" \
  "${BASE}/scrape"; then pass "scrape mercari directOnly OK"; else fail "scrape mercari directOnly NG"; fi

# 8) POST /scrape (mercari quick:false)
hr
if call "scrapeOne mercari quick:false" -X POST -H "Content-Type: application/json" -H "x-api-key: ${KEY}" \
  --data "{\"url\":\"${MERCARI_URL_DEFAULT}\",\"type\":\"mercari\",\"quick\":false}" \
  "${BASE}/scrape"; then pass "scrape mercari quick:false OK"; else fail "scrape mercari quick:false NG"; fi

# 9) POST /scrapeBoth (mercari only)
hr
if call "scrapeBoth (mercari only)" -X POST -H "Content-Type: application/json" -H "x-api-key: ${KEY}" \
  --data "{\"mercariUrl\":\"${MERCARI_URL_DEFAULT}\"}" \
  "${BASE}/scrapeBoth"; then pass "scrapeBoth (mercari only) OK"; else fail "scrapeBoth NG"; fi

hr
printf "SUMMARY: PASS=%d, FAIL=%d\n" "$PASS" "$FAIL"
exit $(( FAIL > 0 ? 1 : 0 ))
