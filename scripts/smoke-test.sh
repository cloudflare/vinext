#!/usr/bin/env bash
set -euo pipefail

# Smoke test deployed examples.
#
# Usage:
#   ./scripts/smoke-test.sh                          # test production URLs
#   ./scripts/smoke-test.sh --preview pr-42           # test PR preview URLs
#
# Checks every deployed example returns HTTP 200 with HTML content.
# Exits non-zero if any check fails.

DOMAIN="vinext.workers.dev"
PREVIEW_ALIAS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --preview)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --preview requires an argument (e.g. --preview pr-42)" >&2
        exit 1
      fi
      PREVIEW_ALIAS="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# Each entry: worker-name path expected-text
# expected-text is a simple string that must appear in the response body.
CHECKS=(
  "app-router-cloudflare         /       vinext"
  "pages-router-cloudflare       /       vinext"
  "app-router-playground         /       Playground"
  "realworld-api-rest            /       vinext"
  "nextra-docs-template          /       Introduction"
  "nextra-docs-template          /about  About"
  "benchmarks                    /       Benchmark"
  "hackernews                    /       Hacker News"
)

tmpfile=$(mktemp)
trap "rm -f '$tmpfile'" EXIT

passed=0
failed=0
errors=()

for check in "${CHECKS[@]}"; do
  read -r worker path expected <<< "$check"

  if [[ -n "$PREVIEW_ALIAS" ]]; then
    url="https://${PREVIEW_ALIAS}-${worker}.${DOMAIN}${path}"
  else
    url="https://${worker}.${DOMAIN}${path}"
  fi

  # Fetch with a 10s timeout, follow redirects
  status=$(curl -s -o "$tmpfile" -w "%{http_code}" -L --max-time 10 "$url" 2>/dev/null || echo "000")
  body=$(cat "$tmpfile" 2>/dev/null || echo "")

  if [[ "$status" != "200" ]]; then
    echo "FAIL  ${worker}${path}  (HTTP ${status})"
    errors+=("${worker}${path} returned HTTP ${status}")
    failed=$((failed + 1))
    continue
  fi

  if [[ -n "$expected" ]] && ! echo "$body" | grep -qiF "$expected"; then
    echo "FAIL  ${worker}${path}  (missing '${expected}' in body)"
    errors+=("${worker}${path} missing expected text '${expected}'")
    failed=$((failed + 1))
    continue
  fi

  echo "  OK  ${worker}${path}"
  passed=$((passed + 1))
done

echo ""
echo "${passed} passed, ${failed} failed"

if [[ $failed -gt 0 ]]; then
  echo ""
  echo "Failures:"
  for err in "${errors[@]}"; do
    echo "  - $err"
  done
  exit 1
fi
