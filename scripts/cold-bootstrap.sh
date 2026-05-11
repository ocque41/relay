#!/usr/bin/env bash
# Cold-agent bootstrap smoke.
#
# Simulates a brand-new agent following the README from zero — no token, no
# prior knowledge of Relay's URL shape. Walks the documented discovery path:
#   1. /.well-known/relay.json    → JSON with apiBase + mcpEndpoint
#   2. /AGENTS.md                  → markdown manifest
#   3. /CLAUDE.md                  → alias of /AGENTS.md
#   4. /llms.txt                   → llmstxt.org index
#   5. /llms-full.txt              → full agent guide
#   6. /v1/index                   → category list (public, no auth)
#   7. /v1/index/<each category>   → per-category provider list (public)
#
# Exits non-zero on any failure. Always prints a final summary so a CI log
# tells you which check broke. Wired into CI for any PR touching app/,
# src/server/routes/well-known.ts, agents-manifest.ts, or index-catalog.ts.
# Also runnable as a Vercel cron post-deploy.
#
# Usage:
#   bash scripts/cold-bootstrap.sh
#   BASE_URL=http://localhost:3000 bash scripts/cold-bootstrap.sh
#   bash scripts/cold-bootstrap.sh https://staging.relay.example.com

set -euo pipefail

BASE_URL="${1:-${BASE_URL:-https://relay.cumulush.com}}"
BASE_URL="${BASE_URL%/}"

BODY_FILE="$(mktemp -t cold-bootstrap.XXXXXX)"
trap 'rm -f "$BODY_FILE"' EXIT

fail=0
pass=0

ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; pass=$((pass + 1)); }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; fail=$((fail + 1)); }

# fetch <name> <path> [--ct <substring>]
# On success, leaves the response body in $BODY_FILE and prints a ✓ line.
# On failure, increments $fail and leaves $BODY_FILE empty.
fetch() {
  local name="$1" path="$2" ct_match=""
  shift 2
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ct) ct_match="$2"; shift 2 ;;
      *)    shift ;;
    esac
  done

  : >"$BODY_FILE"
  local headers status content_type body_size
  if ! headers="$(curl -fsS -D - -o "$BODY_FILE" "$BASE_URL$path" 2>/dev/null)"; then
    bad "$name — fetch failed ($BASE_URL$path)"
    : >"$BODY_FILE"
    return 1
  fi
  status="$(printf '%s' "$headers" | head -1 | awk '{print $2}')"
  content_type="$(printf '%s' "$headers" | tr -d '\r' | grep -i '^content-type:' | head -1 | sed 's/^[Cc]ontent-[Tt]ype: //')"
  body_size="$(wc -c <"$BODY_FILE" | tr -d ' ')"

  if [[ "$status" != "200" ]]; then
    bad "$name — $BASE_URL$path returned HTTP $status"
    return 1
  fi
  if [[ -n "$ct_match" && "$content_type" != *"$ct_match"* ]]; then
    bad "$name — $BASE_URL$path content-type '$content_type' did not match '$ct_match'"
    return 1
  fi
  if [[ "$body_size" -eq 0 ]]; then
    bad "$name — $BASE_URL$path returned empty body"
    return 1
  fi
  ok "$name ($status, $content_type, ${body_size}B)"
  return 0
}

printf '\n→ Cold-bootstrap smoke against %s\n' "$BASE_URL"

# 1. /.well-known/relay.json
fetch ".well-known/relay.json" "/.well-known/relay.json" --ct "application/json"
if [[ -s "$BODY_FILE" ]] && command -v jq >/dev/null 2>&1; then
  api_base="$(jq -er .apiBase <"$BODY_FILE" 2>/dev/null || true)"
  if [[ -n "$api_base" ]]; then
    ok "  apiBase=$api_base"
  else
    bad "  .apiBase missing from /.well-known/relay.json"
  fi
fi

# 2-5. Manifest endpoints
fetch "AGENTS.md"     "/AGENTS.md"     --ct "text/markdown"
fetch "CLAUDE.md"     "/CLAUDE.md"     --ct "text/markdown"
fetch "llms.txt"      "/llms.txt"      --ct "text/plain"
fetch "llms-full.txt" "/llms-full.txt" --ct "text/plain"

# 6. /v1/index (public, no auth) — expand into the per-category fan-out only
# if the index actually parsed.
categories=()
if fetch "v1/index" "/v1/index" --ct "application/json"; then
  if command -v jq >/dev/null 2>&1 && [[ -s "$BODY_FILE" ]]; then
    while IFS= read -r line; do
      [[ -n "$line" ]] && categories+=("$line")
    done < <(jq -r '.categories[]?.slug' <"$BODY_FILE" 2>/dev/null || true)
    if [[ ${#categories[@]} -gt 0 ]]; then
      ok "  categories: ${categories[*]}"
    else
      # Empty index isn't necessarily a failure (sprint scope: ai only,
      # and no public providers in `ai` until a tenant registers one).
      ok "  /v1/index returned 0 categories (no public providers registered yet)"
    fi
  fi
fi

# 7. /v1/index/<category> for every category we discovered.
if [[ ${#categories[@]} -gt 0 ]]; then
  for cat in "${categories[@]}"; do
    fetch "v1/index/$cat" "/v1/index/$cat" --ct "application/json"
  done
fi

printf '\n'
total=$((pass + fail))
if [[ $fail -eq 0 ]]; then
  printf 'OK: %d/%d checks passed.\n' "$pass" "$total"
  exit 0
else
  printf 'FAIL: %d/%d checks failed.\n' "$fail" "$total" >&2
  exit 1
fi
