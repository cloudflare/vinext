#!/usr/bin/env bash
#
# End-to-end SVG test for vinext image optimization.
#
# Usage:
#   ./test-svg.sh             — runs both phases automatically with curl checks
#   ./test-svg.sh --manual    — builds, starts server, and waits for you to
#                               open http://localhost:3456 in a browser
#
# What it does:
#   Phase 1: Builds WITHOUT dangerouslyAllowSVG → SVG returns 400 (blocked)
#   Phase 2: Builds WITH    dangerouslyAllowSVG → SVG returns 200 (allowed)
#
set -uo pipefail
cd "$(dirname "$0")"

VINEXT_CLI="../../../packages/vinext/dist/cli.js"
PORT_PHASE1=3461
PORT_PHASE2=3462
MANUAL="${1:-}"

bold="\033[1m"
dim="\033[2m"
red="\033[31m"
green="\033[32m"
yellow="\033[33m"
cyan="\033[36m"
reset="\033[0m"

SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}
trap cleanup EXIT

wait_for_server() {
  local port="$1"
  for _ in $(seq 1 40); do
    if curl -s -o /dev/null "http://localhost:$port/" 2>/dev/null; then
      return 0
    fi
    sleep 0.25
  done
  echo -e "  ${red}Server failed to start on port $port!${reset}"
  return 1
}

passed=0
failed=0

check() {
  local label="$1"
  local condition="$2"  # "eq" or "contains"
  local actual="$3"
  local expected="$4"

  local ok=false
  if [[ "$condition" == "eq" && "$actual" == "$expected" ]]; then ok=true; fi
  if [[ "$condition" == "contains" && "$actual" == *"$expected"* ]]; then ok=true; fi

  if $ok; then
    echo -e "  ${green}✅ PASS${reset}  $label"
    passed=$((passed + 1))
  else
    echo -e "  ${red}❌ FAIL${reset}  $label"
    echo -e "         got:      \"$(echo "$actual" | head -1)\""
    echo -e "         expected: \"$expected\""
    failed=$((failed + 1))
  fi
}

run_phase() {
  local phase_label="$1"
  local svg_allowed="$2"  # "true" or "false"
  local port="$3"

  echo ""
  echo -e "${bold}═══════════════════════════════════════════════════════════════${reset}"
  echo -e "${bold}  $phase_label${reset}"
  echo -e "${bold}═══════════════════════════════════════════════════════════════${reset}"

  # ── Write next.config.mjs ──
  if [[ "$svg_allowed" == "true" ]]; then
    cat > next.config.mjs << 'CONF'
/** @type {import('next').NextConfig} */
export default {
  images: {
    dangerouslyAllowSVG: true,
    contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
  },
};
CONF
    echo -e "\n  ${cyan}next.config.mjs:${reset}"
    echo -e "    ${yellow}images.dangerouslyAllowSVG: true${reset}"
  else
    cat > next.config.mjs << 'CONF'
/** @type {import('next').NextConfig} */
export default {};
CONF
    echo -e "\n  ${cyan}next.config.mjs:${reset}"
    echo -e "    ${dim}(no images config — SVG blocked by default)${reset}"
  fi

  # ── Build ──
  echo -e "\n  Building..."
  node "$VINEXT_CLI" build 2>&1 | grep -E "built in|Build complete" | while read -r line; do
    echo -e "    ${dim}$line${reset}"
  done

  # ── Start prod server ──
  echo -e "  Starting prod server on :$port..."
  node "$VINEXT_CLI" start --port "$port" &>/dev/null &
  SERVER_PID=$!
  wait_for_server "$port"
  echo ""

  if [[ "$MANUAL" == "--manual" ]]; then
    # ── Manual browser testing mode ──
    echo -e "  ${green}${bold}Server is running!${reset}"
    echo ""
    echo -e "  Open in your browser:"
    echo -e "    ${bold}${cyan}http://localhost:$port${reset}"
    echo ""
    echo -e "  What to look for:"
    if [[ "$svg_allowed" == "true" ]]; then
      echo -e "    Section 1 (SVG via next/image):  ${green}should render the logo${reset}"
    else
      echo -e "    Section 1 (SVG via next/image):  ${red}should show broken image${reset}"
    fi
    echo -e "    Section 2 (direct <img>):         ${green}always renders${reset}"
    echo -e "    Section 3 (JPEG via next/image):  ${green}always renders${reset}"
    echo ""
    echo -e "  Also open ${bold}DevTools → Network${reset} tab:"
    echo -e "    Look for ${cyan}/_vinext/image?url=%2Flogo.svg${reset}"
    if [[ "$svg_allowed" == "true" ]]; then
      echo -e "    Expected status: ${green}200${reset}"
    else
      echo -e "    Expected status: ${red}400${reset}"
    fi
    echo ""
    echo -e "  Press ${bold}Enter${reset} when done observing..."
    read -r
  else
    # ── Automated curl testing mode ──
    local expect_svg
    if [[ "$svg_allowed" == "true" ]]; then expect_svg="200"; else expect_svg="400"; fi

    # Test 1: SVG through image optimization
    local svg_status
    svg_status=$(curl -s -o /dev/null -w "%{http_code}" \
      "http://localhost:$port/_vinext/image?url=%2Flogo.svg&w=640&q=75")
    check "SVG via /_vinext/image → HTTP $expect_svg" eq "$svg_status" "$expect_svg"

    # Test 2: SVG body check
    if [[ "$svg_allowed" == "true" ]]; then
      local svg_body
      svg_body=$(curl -s "http://localhost:$port/_vinext/image?url=%2Flogo.svg&w=640&q=75")
      check "SVG body contains <svg> (served as-is)" contains "$svg_body" "<svg"

      # Check security headers
      local headers
      headers=$(curl -s -D- -o /dev/null "http://localhost:$port/_vinext/image?url=%2Flogo.svg&w=640&q=75" 2>&1)
      check "Content-Security-Policy header present" contains "$headers" "Content-Security-Policy"
      check "X-Content-Type-Options: nosniff present" contains "$headers" "nosniff"
    else
      local svg_body
      svg_body=$(curl -s "http://localhost:$port/_vinext/image?url=%2Flogo.svg&w=640&q=75")
      check "Error: not an allowed image type" eq "$svg_body" "The requested resource is not an allowed image type"
    fi

    # Test 3: JPEG always works
    local jpg_status
    jpg_status=$(curl -s -o /dev/null -w "%{http_code}" \
      "http://localhost:$port/_vinext/image?url=%2Fphoto.jpg&w=640&q=75")
    check "JPEG via /_vinext/image → HTTP 200 (always works)" eq "$jpg_status" "200"

    # Test 4: Direct SVG always works (bypasses optimizer)
    local direct_status
    direct_status=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port/logo.svg")
    check "Direct /logo.svg → HTTP 200 (bypasses optimizer)" eq "$direct_status" "200"

    # Test 5: Page renders
    local page_status
    page_status=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port/")
    check "/ page renders → HTTP 200" eq "$page_status" "200"
  fi

  # ── Stop server ──
  cleanup
  sleep 1  # Give the port time to be released
}

echo ""
echo -e "${bold}═══════════════════════════════════════════════════════════════${reset}"
echo -e "${bold}   vinext — dangerouslyAllowSVG End-to-End Test${reset}"
echo -e "${bold}═══════════════════════════════════════════════════════════════${reset}"

# Save original config
[[ -f next.config.mjs ]] && cp next.config.mjs next.config.mjs.bak

# Phase 1: SVG blocked (use first port)
run_phase "Phase 1: WITHOUT dangerouslyAllowSVG (SVG should be BLOCKED)" "false" "$PORT_PHASE1"

# Phase 2: SVG allowed (use second port to avoid port conflict)
run_phase "Phase 2: WITH dangerouslyAllowSVG: true (SVG should be ALLOWED)" "true" "$PORT_PHASE2"

# Restore original config
if [[ -f next.config.mjs.bak ]]; then
  mv next.config.mjs.bak next.config.mjs
else
  rm -f next.config.mjs
fi

echo ""
echo -e "${bold}═══════════════════════════════════════════════════════════════${reset}"
if [[ $failed -eq 0 ]]; then
  echo -e "${green}${bold}  All $passed checks passed!${reset}"
else
  echo -e "${red}${bold}  $passed passed, $failed failed${reset}"
fi
echo -e "${bold}═══════════════════════════════════════════════════════════════${reset}"
echo ""

exit $failed
