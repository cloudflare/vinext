#!/usr/bin/env bash
set -euo pipefail

# Test vinext against ecosystem repos from .github/repos.json
# Usage: ./scripts/test-repos.sh
#
# Clones each repo, installs vinext, runs build + dev server smoke test
# (hits the index page). All repos run in parallel. Results summarized at the end.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VINEXT_PKG="$ROOT_DIR/packages/vinext"
WORK_DIR="$ROOT_DIR/.ecosystem-test"
REPOS_JSON="$ROOT_DIR/.github/repos.json"
RESULTS_DIR="$WORK_DIR/results"
MAX_PARALLEL=4
DEV_SERVER_TIMEOUT=30  # seconds to wait for dev server to respond

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

log() { echo -e "${BOLD}[$1]${NC} $2"; }
pass() { echo -e "${GREEN}PASS${NC} $1"; }
fail() { echo -e "${RED}FAIL${NC} $1"; }
warn() { echo -e "${YELLOW}WARN${NC} $1"; }

cleanup() {
  # Kill any leftover dev servers
  if [[ -f "$WORK_DIR/pids" ]]; then
    while read -r pid; do
      kill "$pid" 2>/dev/null || true
    done < "$WORK_DIR/pids"
    rm -f "$WORK_DIR/pids"
  fi
}
trap cleanup EXIT

# Parse repos.json
repos=$(jq -c '.[]' "$REPOS_JSON")
repo_count=$(echo "$repos" | wc -l | tr -d ' ')

echo ""
echo -e "${BOLD}vinext ecosystem test${NC}"
echo -e "Testing $repo_count repos from .github/repos.json"
echo ""

# Clean previous run
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR" "$RESULTS_DIR"
touch "$WORK_DIR/pids"

test_repo() {
  local name="$1"
  local url="$2"
  local repo_dir="$WORK_DIR/$name"
  local log_file="$RESULTS_DIR/$name.log"
  local result_file="$RESULTS_DIR/$name.result"

  {
    echo "clone=fail"
    echo "install=skip"
    echo "vinext_install=skip"
    echo "build=skip"
    echo "dev=skip"
  } > "$result_file"

  exec > "$log_file" 2>&1

  echo "=== Testing $name ==="
  echo "URL: $url"
  echo ""

  # Clone
  echo "--- clone ---"
  if ! git clone --depth 1 "$url" "$repo_dir"; then
    echo "FAILED: git clone"
    return 1
  fi
  sed -i '' 's/^clone=.*/clone=pass/' "$result_file"

  cd "$repo_dir"

  # Install deps
  echo ""
  echo "--- install ---"
  sed -i '' 's/^install=.*/install=fail/' "$result_file"
  if ! npm install --legacy-peer-deps 2>&1; then
    echo "FAILED: npm install"
    return 1
  fi
  sed -i '' 's/^install=.*/install=pass/' "$result_file"

  # Install vinext from local build
  echo ""
  echo "--- install vinext ---"
  sed -i '' 's/^vinext_install=.*/vinext_install=fail/' "$result_file"
  if ! npm install --legacy-peer-deps "$VINEXT_PKG" 2>&1; then
    echo "FAILED: npm install vinext"
    return 1
  fi
  sed -i '' 's/^vinext_install=.*/vinext_install=pass/' "$result_file"

  # Build
  echo ""
  echo "--- build ---"
  sed -i '' 's/^build=.*/build=fail/' "$result_file"
  if npm run build 2>&1; then
    sed -i '' 's/^build=.*/build=pass/' "$result_file"
  else
    echo "FAILED: npm run build"
    # Don't return — still try dev server
  fi

  # Dev server smoke test
  echo ""
  echo "--- dev server ---"
  sed -i '' 's/^dev=.*/dev=fail/' "$result_file"

  # Find an available port
  local port=$((3100 + RANDOM % 900))

  # Start dev server in background
  PORT=$port npx vinext dev --port "$port" &
  local dev_pid=$!
  echo "$dev_pid" >> "$WORK_DIR/pids"

  # Wait for the server to respond
  local started=false
  for i in $(seq 1 "$DEV_SERVER_TIMEOUT"); do
    if curl -sf -o /dev/null "http://localhost:$port" 2>/dev/null; then
      started=true
      break
    fi
    sleep 1
  done

  if $started; then
    # Fetch the page and check we got HTML
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port" 2>/dev/null || echo "000")
    echo "Dev server responded with HTTP $status"
    if [[ "$status" =~ ^[23] ]]; then
      sed -i '' 's/^dev=.*/dev=pass/' "$result_file"
    fi
  else
    echo "Dev server did not respond within ${DEV_SERVER_TIMEOUT}s"
  fi

  # Kill dev server
  kill "$dev_pid" 2>/dev/null || true
  wait "$dev_pid" 2>/dev/null || true
}

# Run repos in parallel with limited concurrency
pids=()
names=()
idx=0

while IFS= read -r repo; do
  name=$(echo "$repo" | jq -r '.name')
  url=$(echo "$repo" | jq -r '.url')

  log "$name" "starting..."
  test_repo "$name" "$url" &
  pids+=($!)
  names+=("$name")
  idx=$((idx + 1))

  # Throttle parallelism
  if (( ${#pids[@]} >= MAX_PARALLEL )); then
    wait "${pids[0]}" 2>/dev/null || true
    pids=("${pids[@]:1}")
  fi
done <<< "$repos"

# Wait for remaining
for pid in "${pids[@]}"; do
  wait "$pid" 2>/dev/null || true
done

# Print results
echo ""
echo -e "${BOLD}============================================${NC}"
echo -e "${BOLD}  Results${NC}"
echo -e "${BOLD}============================================${NC}"
echo ""

printf "%-30s %-8s %-8s %-10s %-8s %-8s\n" "REPO" "CLONE" "INSTALL" "VINEXT" "BUILD" "DEV"
printf "%-30s %-8s %-8s %-10s %-8s %-8s\n" "----" "-----" "-------" "------" "-----" "---"

pass_count=0
fail_count=0

for result_file in "$RESULTS_DIR"/*.result; do
  name=$(basename "$result_file" .result)
  clone=$(grep '^clone=' "$result_file" | cut -d= -f2)
  install=$(grep '^install=' "$result_file" | cut -d= -f2)
  vinext_install=$(grep '^vinext_install=' "$result_file" | cut -d= -f2)
  build=$(grep '^build=' "$result_file" | cut -d= -f2)
  dev=$(grep '^dev=' "$result_file" | cut -d= -f2)

  # Colorize
  c_clone=$([[ "$clone" == "pass" ]] && echo -e "${GREEN}pass${NC}" || echo -e "${RED}$clone${NC}")
  c_install=$([[ "$install" == "pass" ]] && echo -e "${GREEN}pass${NC}" || echo -e "${RED}$install${NC}")
  c_vinext=$([[ "$vinext_install" == "pass" ]] && echo -e "${GREEN}pass${NC}" || echo -e "${RED}$vinext_install${NC}")
  c_build=$([[ "$build" == "pass" ]] && echo -e "${GREEN}pass${NC}" || echo -e "${YELLOW}$build${NC}")
  c_dev=$([[ "$dev" == "pass" ]] && echo -e "${GREEN}pass${NC}" || echo -e "${RED}$dev${NC}")

  printf "%-30s %-17s %-17s %-19s %-17s %-17s\n" "$name" "$c_clone" "$c_install" "$c_vinext" "$c_build" "$c_dev"

  if [[ "$dev" == "pass" ]]; then
    pass_count=$((pass_count + 1))
  else
    fail_count=$((fail_count + 1))
  fi
done

echo ""
echo -e "${GREEN}$pass_count passed${NC}, ${RED}$fail_count failed${NC} out of $repo_count repos"
echo ""
echo "Logs: $RESULTS_DIR/*.log"
