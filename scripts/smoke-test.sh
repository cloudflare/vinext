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
  "app-router-cloudflare         /web-worker  start worker"
  "pages-router-cloudflare       /       vinext"
  "app-router-playground         /       Playground"
  "realworld-api-rest            /       vinext"
  "nextra-docs-template          /       Introduction"
  "nextra-docs-template          /about  About"
  "benchmarks                    /       Benchmark"
  "hackernews                    /       Hacker News"
  "workers-cache                /       Request-context cache demo"
  "vinext-web                    /       Run your Next.js app on Vite"
)

# Content-correctness checks for dynamic routes.
# Verify that pages with dynamic params render the RIGHT data — not
# stale/cached data from a different param value.
# Format: "worker-name  path  must-contain  must-not-contain"
# Both strings are matched case-insensitively against the response body.
CONTENT_CHECKS=(
  # Nested layouts: each section must show its own products
  'app-router-playground  /layouts/electronics  alt="Phone"       alt="Basketball"'
  'app-router-playground  /layouts/sports       alt="Basketball"  alt="Phone"'
  'app-router-playground  /layouts/clothing     alt="Top"         alt="Phone"'
  # Route groups: subcategory pages must show the correct items
  'app-router-playground  /route-groups/clothing/shoes  alt="Shoes"  alt="Shorts"'
)

tmpfile=$(mktemp)
rsc_headers=$(mktemp)
trap "rm -f '$tmpfile' '$rsc_headers'" EXIT

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

# ---------------------------------------------------------------------------
# Real Workers Cache RSC reuse
# ---------------------------------------------------------------------------

if [[ -n "$PREVIEW_ALIAS" ]]; then
  rsc_origin="https://${PREVIEW_ALIAS}-workers-cache.${DOMAIN}"
else
  rsc_origin="https://workers-cache.${DOMAIN}"
fi
rsc_probe_paths=("cached/intro" "cached/featured")
rsc_url=""
version_probe_url=""
rsc_probe_label=""
warm_rsc_request=()
browser_rsc_request=()

set_rsc_probe_path() {
  local path="$1"
  rsc_url="${rsc_origin}/${path}?_rsc"
  version_probe_url="${rsc_origin}/${path}?__vinext_version_probe=smoke"
  rsc_probe_label="workers-cache/${path}?_rsc"
  warm_rsc_request=(
    -H "Accept: text/x-component"
    -H "RSC: 1"
    -H "User-Agent: vinext-cloudflare-cdn-warm"
    --max-time 10
    "$rsc_url"
  )
  browser_rsc_request=(
    -H "Accept: text/x-component"
    -H "Accept-Language: en-GB,en-US;q=0.9,en;q=0.8"
    -H "RSC: 1"
    -H "User-Agent: Mozilla/5.0 AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36"
    --max-time 10
    "$rsc_url"
  )
}

probe_worker_version() {
  local status version
  status=$(curl -sS -o "$tmpfile" -D "$rsc_headers" -w "%{http_code}" \
    -H "Cache-Control: no-cache" \
    -H "X-Vinext-Version-Probe: 1" \
    -H "User-Agent: vinext-cloudflare-version-probe" \
    --max-time 10 \
    "$version_probe_url" || echo "000")
  version=$(awk 'BEGIN { IGNORECASE=1 } /^x-vinext-worker-version:/ { gsub("\r", "", $2); print $2 }' "$rsc_headers" | tail -1)
  if [[ "$status" == "204" && -n "$version" && "$version" != "unavailable" ]]; then
    printf '%s' "$version"
    return 0
  fi
  return 1
}

wait_for_stable_worker_version() {
  local previous="" consecutive=0 version
  for _attempt in {1..10}; do
    if version=$(probe_worker_version); then
      if [[ "$version" == "$previous" ]]; then
        consecutive=$((consecutive + 1))
      else
        previous="$version"
        consecutive=1
      fi
      if [[ "$consecutive" -ge 3 ]]; then
        printf '%s' "$version"
        return 0
      fi
    else
      previous=""
      consecutive=0
    fi
    sleep 1
  done
  return 1
}

normalize_vary() {
  tr ',' '\n' <<< "$1" |
    sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' |
    tr '[:upper:]' '[:lower:]' |
    sed '/^$/d' |
    sort -u |
    paste -sd ',' -
}

expected_rsc_vary=$(printf '%s\n' \
  accept \
  authorization \
  cookie \
  host \
  next-router-prefetch \
  next-router-segment-prefetch \
  next-router-state-tree \
  rsc \
  x-vinext-client-reuse-manifest \
  x-vinext-interception-context \
  x-vinext-interception-id \
  x-vinext-mounted-slots \
  x-vinext-rsc-render-mode \
  x-vinext-rsc-state-fingerprint \
  x-forwarded-proto |
  sort -u |
  paste -sd ',' -)

run_warm_rsc_probe() {
  first_status=$(curl -sS -o "$tmpfile" -D "$rsc_headers" -w "%{http_code}" "${warm_rsc_request[@]}" || echo "000")
  first_cache_status=$(awk 'BEGIN { IGNORECASE=1 } /^cf-cache-status:/ { gsub("\r", "", $2); print toupper($2) }' "$rsc_headers" | tail -1)
  first_location=$(awk 'BEGIN { IGNORECASE=1 } /^location:/ { print $2 }' "$rsc_headers" | tr -d '\r' | tail -1)
  first_vary=$(awk 'BEGIN { IGNORECASE=1 } /^vary:/ { sub(/^[^:]+:[[:space:]]*/, ""); gsub("\r", ""); print }' "$rsc_headers" | tail -1)
  first_content_type=$(awk 'BEGIN { IGNORECASE=1 } /^content-type:/ { sub(/^[^:]+:[[:space:]]*/, ""); gsub("\r", ""); print tolower($0) }' "$rsc_headers" | tail -1)

  warm_status="$first_status"
  warm_cache_status="$first_cache_status"
  warm_location="$first_location"
  warm_vary="$first_vary"
  warm_content_type="$first_content_type"
  warm_failure=""
  warm_hit_attempt=""
  for attempt in {1..8}; do
    if [[ "$attempt" -gt 1 ]]; then
      warm_status=$(curl -sS -o "$tmpfile" -D "$rsc_headers" -w "%{http_code}" "${warm_rsc_request[@]}" || echo "000")
      warm_cache_status=$(awk 'BEGIN { IGNORECASE=1 } /^cf-cache-status:/ { gsub("\r", "", $2); print toupper($2) }' "$rsc_headers" | tail -1)
      warm_location=$(awk 'BEGIN { IGNORECASE=1 } /^location:/ { print $2 }' "$rsc_headers" | tr -d '\r' | tail -1)
      warm_vary=$(awk 'BEGIN { IGNORECASE=1 } /^vary:/ { sub(/^[^:]+:[[:space:]]*/, ""); gsub("\r", ""); print }' "$rsc_headers" | tail -1)
      warm_content_type=$(awk 'BEGIN { IGNORECASE=1 } /^content-type:/ { sub(/^[^:]+:[[:space:]]*/, ""); gsub("\r", ""); print tolower($0) }' "$rsc_headers" | tail -1)
    fi

    if [[ "$warm_status" != "200" || -n "$warm_location" ]]; then
      warm_failure="HTTP ${warm_status}${warm_location:+, location ${warm_location}}"
      break
    fi
    if [[ "$warm_content_type" != *"text/x-component"* ]]; then
      warm_failure="Content-Type ${warm_content_type:-missing}"
      break
    fi
    if [[ "$(normalize_vary "$warm_vary")" != "$expected_rsc_vary" ]]; then
      warm_failure="Vary ${warm_vary:-missing}"
      break
    fi
    if [[ "$warm_cache_status" == "HIT" ]]; then
      warm_hit_attempt="$attempt"
      break
    fi
    if [[ "$attempt" -lt 8 ]]; then
      sleep 1
    fi
  done
}

run_browser_rsc_probe() {
  # Send the browser shape exactly once on a verified Worker version. Retrying
  # a MISS on the same path could populate a second variant and hide a Vary bug.
  second_status=$(curl -sS -o "$tmpfile" -D "$rsc_headers" -w "%{http_code}" "${browser_rsc_request[@]}" || echo "000")
  second_cache_status=$(awk 'BEGIN { IGNORECASE=1 } /^cf-cache-status:/ { gsub("\r", "", $2); print toupper($2) }' "$rsc_headers" | tail -1)
  second_location=$(awk 'BEGIN { IGNORECASE=1 } /^location:/ { print $2 }' "$rsc_headers" | tr -d '\r' | tail -1)
  second_vary=$(awk 'BEGIN { IGNORECASE=1 } /^vary:/ { sub(/^[^:]+:[[:space:]]*/, ""); gsub("\r", ""); print }' "$rsc_headers" | tail -1)
  second_content_type=$(awk 'BEGIN { IGNORECASE=1 } /^content-type:/ { sub(/^[^:]+:[[:space:]]*/, ""); gsub("\r", ""); print tolower($0) }' "$rsc_headers" | tail -1)
  canonical_failure=""
  if [[ "$second_status" != "200" || -n "$second_location" ]]; then
    canonical_failure="HTTP ${second_status}${second_location:+, location ${second_location}}"
  elif [[ "$second_content_type" != *"text/x-component"* ]]; then
    canonical_failure="Content-Type ${second_content_type:-missing}"
  elif [[ "$(normalize_vary "$second_vary")" != "$expected_rsc_vary" ]]; then
    canonical_failure="Vary ${second_vary:-missing}"
  elif [[ "$second_cache_status" != "HIT" ]]; then
    canonical_failure="CF-Cache-Status ${second_cache_status:-missing}"
  fi
}

run_isolation_probes() {
  cookie_status=$(curl -sS -o "$tmpfile" -D "$rsc_headers" -w "%{http_code}" \
    -H "Accept: text/x-component" \
    -H "RSC: 1" \
    -H "Cookie: __prerender_bypass=vinext-cache-isolation-probe" \
    --max-time 10 \
    "$rsc_url" || echo "000")
  cookie_cache_status=$(awk 'BEGIN { IGNORECASE=1 } /^cf-cache-status:/ { gsub("\r", "", $2); print toupper($2) }' "$rsc_headers" | tail -1)
  cookie_cache_control=$(awk 'BEGIN { IGNORECASE=1 } /^cache-control:/ { sub(/^[^:]+:[[:space:]]*/, ""); gsub("\r", ""); print tolower($0) }' "$rsc_headers" | tail -1)

  authorization_status=$(curl -sS -o "$tmpfile" -D "$rsc_headers" -w "%{http_code}" \
    -H "Accept: text/x-component" \
    -H "RSC: 1" \
    -H "Authorization: Bearer vinext-cache-isolation-probe" \
    --max-time 10 \
    "$rsc_url" || echo "000")
  authorization_cache_status=$(awk 'BEGIN { IGNORECASE=1 } /^cf-cache-status:/ { gsub("\r", "", $2); print toupper($2) }' "$rsc_headers" | tail -1)
  authorization_cache_control=$(awk 'BEGIN { IGNORECASE=1 } /^cache-control:/ { sub(/^[^:]+:[[:space:]]*/, ""); gsub("\r", ""); print tolower($0) }' "$rsc_headers" | tail -1)

  invalid_accept_failure=""
  for invalid_accept in "application/json" "text/x-component, */*" "TEXT/X-COMPONENT"; do
    invalid_status=$(curl -sS -o "$tmpfile" -D "$rsc_headers" -w "%{http_code}" \
      -H "Accept: ${invalid_accept}" \
      -H "RSC: 1" \
      --max-time 10 \
      "$rsc_url" || echo "000")
    invalid_cache_status=$(awk 'BEGIN { IGNORECASE=1 } /^cf-cache-status:/ { gsub("\r", "", $2); print toupper($2) }' "$rsc_headers" | tail -1)
    invalid_cache_control=$(awk 'BEGIN { IGNORECASE=1 } /^cache-control:/ { sub(/^[^:]+:[[:space:]]*/, ""); gsub("\r", ""); print tolower($0) }' "$rsc_headers" | tail -1)
    if [[ "$invalid_status" != "307" || "$invalid_cache_status" == "HIT" || "$invalid_cache_control" != *"no-store"* ]]; then
      invalid_accept_failure="Accept ${invalid_accept}: HTTP ${invalid_status}, CF-Cache-Status ${invalid_cache_status:-missing}, Cache-Control ${invalid_cache_control:-missing}"
      break
    fi
  done
}

version_guard_failure=""
stable_worker_version=""
canonical_failure=""
for rsc_probe_path in "${rsc_probe_paths[@]}"; do
  set_rsc_probe_path "$rsc_probe_path"
  version_guard_failure=""
  if ! stable_worker_version=$(wait_for_stable_worker_version); then
    version_guard_failure="VINEXT_VERSION_METADATA unavailable or preview version did not stabilize"
    break
  fi

  run_warm_rsc_probe
  if [[ -n "$warm_failure" || -z "$warm_hit_attempt" ]]; then
    break
  fi

  if ! version_after_warm=$(probe_worker_version); then
    version_guard_failure="VINEXT_VERSION_METADATA unavailable after warming"
    break
  fi
  if [[ "$version_after_warm" != "$stable_worker_version" ]]; then
    version_guard_failure="preview version changed while warming"
    continue
  fi
  if ! version_before_browser=$(probe_worker_version); then
    version_guard_failure="VINEXT_VERSION_METADATA unavailable before browser probe"
    break
  fi
  if [[ "$version_before_browser" != "$stable_worker_version" ]]; then
    version_guard_failure="preview version changed before browser probe"
    continue
  fi

  run_browser_rsc_probe
  if ! version_after_browser=$(probe_worker_version); then
    version_guard_failure="VINEXT_VERSION_METADATA unavailable after browser probe"
    break
  fi
  if [[ "$version_after_browser" != "$stable_worker_version" ]]; then
    version_guard_failure="preview version changed during browser probe"
    continue
  fi

  run_isolation_probes
  if ! version_after_isolation=$(probe_worker_version); then
    version_guard_failure="VINEXT_VERSION_METADATA unavailable after isolation probes"
    break
  fi
  if [[ "$version_after_isolation" != "$stable_worker_version" ]]; then
    version_guard_failure="preview version changed during isolation probes"
    continue
  fi

  # Same-version MISS is a real cache-identity failure. Do not retry it.
  version_guard_failure=""
  break
done

if [[ -n "$version_guard_failure" ]]; then
  echo "FAIL  ${rsc_probe_label}  (${version_guard_failure})"
  errors+=("canonical RSC cache proof could not pin one Worker version")
  failed=$((failed + 1))
elif [[ "$first_status" != "200" || -n "$first_location" ]]; then
  echo "FAIL  ${rsc_probe_label}  (canonical request returned HTTP ${first_status}${first_location:+, location ${first_location}})"
  errors+=("canonical RSC request was not served directly")
  failed=$((failed + 1))
elif [[ "$first_content_type" != *"text/x-component"* ]]; then
  echo "FAIL  ${rsc_probe_label}  (warm Content-Type: ${first_content_type:-missing})"
  errors+=("canonical warm request did not return an RSC payload")
  failed=$((failed + 1))
elif [[ "$(normalize_vary "$first_vary")" != "$expected_rsc_vary" ]]; then
  echo "FAIL  ${rsc_probe_label}  (warm Vary: ${first_vary:-missing})"
  errors+=("canonical warm response did not use the required RSC Vary fields")
  failed=$((failed + 1))
elif [[ -z "$first_cache_status" || "$first_cache_status" == "BYPASS" || "$first_cache_status" == "DYNAMIC" || "$first_cache_status" == "NONE/UNKNOWN" ]]; then
  echo "FAIL  ${rsc_probe_label}  (first CF-Cache-Status: ${first_cache_status:-missing})"
  errors+=("canonical RSC response was not admitted to Workers Cache")
  failed=$((failed + 1))
elif [[ -n "$warm_failure" ]]; then
  echo "FAIL  ${rsc_probe_label}  (warm request returned ${warm_failure})"
  errors+=("canonical warm request did not retain the required cache variant")
  failed=$((failed + 1))
elif [[ -z "$warm_hit_attempt" ]]; then
  echo "FAIL  ${rsc_probe_label}  (warm variant never reached HIT; last HTTP ${warm_status}, CF-Cache-Status: ${warm_cache_status:-missing})"
  errors+=("canonical warm variant was not present in Workers Cache")
  failed=$((failed + 1))
elif [[ -n "$canonical_failure" ]]; then
  echo "FAIL  ${rsc_probe_label}  (canonical browser request returned ${canonical_failure})"
  errors+=("canonical browser RSC request did not match the warmed cache variant")
  failed=$((failed + 1))
elif [[ -n "$invalid_accept_failure" ]]; then
  echo "FAIL  ${rsc_probe_label}  (${invalid_accept_failure})"
  errors+=("invalid Accept request reused or populated the canonical RSC cache entry")
  failed=$((failed + 1))
elif [[ "$cookie_status" != "200" || "$cookie_cache_status" == "HIT" || "$cookie_cache_control" != *"no-store"* ]]; then
  echo "FAIL  ${rsc_probe_label}  (cookie HTTP ${cookie_status}, CF-Cache-Status: ${cookie_cache_status:-missing}, Cache-Control: ${cookie_cache_control:-missing})"
  errors+=("cookie-bearing RSC request reused or populated the anonymous cache entry")
  failed=$((failed + 1))
elif [[ "$authorization_status" != "200" || "$authorization_cache_status" == "HIT" || "$authorization_cache_control" != *"no-store"* ]]; then
  echo "FAIL  ${rsc_probe_label}  (authorization HTTP ${authorization_status}, CF-Cache-Status: ${authorization_cache_status:-missing}, Cache-Control: ${authorization_cache_control:-missing})"
  errors+=("authorization-bearing RSC request reused or populated the anonymous cache entry")
  failed=$((failed + 1))
else
  echo "  OK  ${rsc_probe_label}  (version ${stable_worker_version}; warm ${first_cache_status} -> warm HIT on attempt ${warm_hit_attempt} -> first browser request HIT; invalid Accept, cookie, and authorization isolated)"
  passed=$((passed + 1))
fi

# ---------------------------------------------------------------------------
# Content-correctness checks: right data for the right dynamic route
# ---------------------------------------------------------------------------

for check in "${CONTENT_CHECKS[@]}"; do
  read -r worker path must_contain must_not_contain <<< "$check"

  if [[ -n "$PREVIEW_ALIAS" ]]; then
    url="https://${PREVIEW_ALIAS}-${worker}.${DOMAIN}${path}"
  else
    url="https://${worker}.${DOMAIN}${path}"
  fi

  status=$(curl -s -o "$tmpfile" -w "%{http_code}" -L --max-time 10 "$url" 2>/dev/null || echo "000")
  body=$(cat "$tmpfile" 2>/dev/null || echo "")

  if [[ "$status" != "200" ]]; then
    echo "FAIL  ${worker}${path}  (HTTP ${status})"
    errors+=("${worker}${path} returned HTTP ${status}")
    failed=$((failed + 1))
    continue
  fi

  if ! echo "$body" | grep -qiF "$must_contain"; then
    echo "FAIL  ${worker}${path}  (missing '${must_contain}')"
    errors+=("${worker}${path} missing '${must_contain}' — wrong content rendered")
    failed=$((failed + 1))
    continue
  fi

  if echo "$body" | grep -qiF "$must_not_contain"; then
    echo "FAIL  ${worker}${path}  (found '${must_not_contain}' — wrong section data)"
    errors+=("${worker}${path} contains '${must_not_contain}' — data from wrong dynamic param")
    failed=$((failed + 1))
    continue
  fi

  echo "  OK  ${worker}${path}  (content correct)"
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
