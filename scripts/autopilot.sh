#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# autopilot.sh — Full issue-to-merge workflow via OpenCode
#
# Usage:
#   ./scripts/autopilot.sh <issue-number> [options]
#
# Options:
#   --server <url>    Attach to an existing server instead of starting one
#   --port <number>   Port for the auto-started server (default: 4096)
#   --skip-fix        Skip the fix step (PR already exists)
#   --skip-review     Skip the review step
#   --pr <number>     Use existing PR number (with --skip-fix)
#   --dry-run         Print what would be done without running
#
# The script auto-starts an OpenCode server and tears it down
# on exit. Watch progress in another terminal:
#
#   opencode attach http://localhost:4096
#
# Each step creates its own OpenCode session visible in the TUI.
# ─────────────────────────────────────────────────────────────

ISSUE=""
SERVER_URL=""
SERVER_PORT="4096"
SKIP_FIX=false
SKIP_REVIEW=false
PR_NUMBER=""
DRY_RUN=false
STARTED_SERVER=false
SERVER_PID=""

# ── Parse args ────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --server)    SERVER_URL="$2"; shift 2 ;;
    --port)      SERVER_PORT="$2"; shift 2 ;;
    --skip-fix)  SKIP_FIX=true; shift ;;
    --skip-review) SKIP_REVIEW=true; shift ;;
    --pr)        PR_NUMBER="$2"; shift 2 ;;
    --dry-run)   DRY_RUN=true; shift ;;
    --help|-h)
      sed -n '3,/^# ──────/p' "$0" | head -n -1 | sed 's/^# \?//'
      exit 0
      ;;
    -*)          echo "Unknown flag: $1"; exit 1 ;;
    *)
      if [[ -z "$ISSUE" ]]; then
        ISSUE="$1"; shift
      else
        echo "Unexpected argument: $1"; exit 1
      fi
      ;;
  esac
done

if [[ -z "$ISSUE" ]]; then
  echo "Usage: autopilot.sh <issue-number> [options]"
  echo "Run with --help for full usage."
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_DIR="${REPO_ROOT}/../vinext-fix-${ISSUE}"

# ── Server lifecycle ──────────────────────────────────────────
cleanup() {
  if [[ "$STARTED_SERVER" == "true" && -n "$SERVER_PID" ]]; then
    echo ""
    echo "  Stopping OpenCode server (pid ${SERVER_PID})..."
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

discover_server() {
  # Find a running opencode process listening on a TCP port
  local ports
  ports=$(lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null \
    | awk '/opencode/ {print $9}' \
    | grep -o '[0-9]*$' \
    | sort -u)

  for port in $ports; do
    local url="http://127.0.0.1:${port}"
    if curl -sf "${url}/global/health" > /dev/null 2>&1; then
      echo "${url}"
      return 0
    fi
  done
  return 1
}

ensure_server() {
  # If user gave --server, just verify it's reachable
  if [[ -n "$SERVER_URL" ]]; then
    if ! curl -sf "${SERVER_URL}/global/health" > /dev/null 2>&1; then
      echo "ERROR: No OpenCode server at ${SERVER_URL}"
      exit 1
    fi
    echo "  Using server at ${SERVER_URL}"
    return
  fi

  # Try to discover a running server (e.g. desktop app)
  local discovered
  discovered=$(discover_server || true)
  if [[ -n "$discovered" ]]; then
    SERVER_URL="$discovered"
    echo "  Found running OpenCode server at ${SERVER_URL}"
    return
  fi

  # Nothing running — start our own
  SERVER_URL="http://localhost:${SERVER_PORT}"

  echo "  Starting OpenCode server on port ${SERVER_PORT}..."
  opencode serve --port "${SERVER_PORT}" > /dev/null 2>&1 &
  SERVER_PID=$!
  STARTED_SERVER=true

  # Wait for it to be ready (up to 30s)
  local attempts=0
  while ! curl -sf "${SERVER_URL}/global/health" > /dev/null 2>&1; do
    if [[ $attempts -ge 30 ]]; then
      echo "ERROR: Server failed to start within 30s"
      exit 1
    fi
    sleep 1
    attempts=$((attempts + 1))
  done

  echo "  Server ready at ${SERVER_URL}"
  echo "  Watch progress: opencode attach ${SERVER_URL}"
}

if [[ "$DRY_RUN" == "false" ]]; then
  ensure_server
fi

# ── Helpers ───────────────────────────────────────────────────
step() {
  local step_num="$1"
  local step_name="$2"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Step ${step_num}: ${step_name}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
}

run_opencode() {
  local title="$1"
  local command="$2"
  local args="$3"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] opencode run --attach ${SERVER_URL} --title \"${title}\" --command ${command} ${args}"
    return 0
  fi

  opencode run \
    --attach "${SERVER_URL}" \
    --title "${title}" \
    --command "${command}" "${args}"
}

find_pr_number() {
  # Try to find the PR from the worktree's branch
  if [[ -d "${WORKTREE_DIR}" ]]; then
    local branch
    branch=$(git -C "${WORKTREE_DIR}" branch --show-current 2>/dev/null || true)
    if [[ -n "${branch}" ]]; then
      local pr
      pr=$(gh pr list --repo cloudflare/vinext --head "${branch}" --json number -q '.[0].number' 2>/dev/null || true)
      if [[ -n "${pr}" ]]; then
        echo "${pr}"
        return 0
      fi
    fi
  fi

  # Fallback: search by issue reference
  local pr
  pr=$(gh pr list --repo cloudflare/vinext --search "Fixes #${ISSUE}" --json number -q '.[0].number' 2>/dev/null || true)
  if [[ -n "${pr}" ]]; then
    echo "${pr}"
    return 0
  fi

  return 1
}

# ── Main ──────────────────────────────────────────────────────
echo "╔═══════════════════════════════════════════════════════╗"
echo "║  Autopilot: Issue #${ISSUE}"
echo "║  Server:    ${SERVER_URL}"
echo "║  Worktree:  ${WORKTREE_DIR}"
echo "╚═══════════════════════════════════════════════════════╝"

# ── Step 1: Fix the issue ─────────────────────────────────────
if [[ "$SKIP_FIX" == "false" ]]; then
  step 1 "Fix issue #${ISSUE}"
  run_opencode "Fix #${ISSUE}" "fix-issue" "${ISSUE}"
else
  echo ""
  echo "  Skipping fix step."
fi

# ── Resolve PR number ─────────────────────────────────────────
if [[ -z "$PR_NUMBER" ]]; then
  echo ""
  echo "  Resolving PR number..."
  PR_NUMBER=$(find_pr_number || true)

  if [[ -z "$PR_NUMBER" ]]; then
    echo "ERROR: Could not find a PR for issue #${ISSUE}."
    echo "If the PR already exists, re-run with: --pr <number>"
    exit 1
  fi
fi

echo "  PR #${PR_NUMBER}"

# ── Step 2: Review the PR ────────────────────────────────────
if [[ "$SKIP_REVIEW" == "false" ]]; then
  step 2 "Review PR #${PR_NUMBER}"
  run_opencode "Review PR #${PR_NUMBER}" "review-pr" "${PR_NUMBER}"
else
  echo ""
  echo "  Skipping review step."
fi

# ── Step 3: Address review comments ──────────────────────────
step 3 "Address review for PR #${PR_NUMBER}"
run_opencode "Address review PR #${PR_NUMBER}" "address-review" "${PR_NUMBER}"

# ── Done ──────────────────────────────────────────────────────
echo ""
echo "╔═══════════════════════════════════════════════════════╗"
echo "║  Done!"
echo "║"
echo "║  Sessions created:"
if [[ "$SKIP_FIX" == "false" ]]; then
echo "║    1. Fix #${ISSUE}"
fi
if [[ "$SKIP_REVIEW" == "false" ]]; then
echo "║    2. Review PR #${PR_NUMBER}"
fi
echo "║    3. Address review PR #${PR_NUMBER}"
echo "║"
echo "║  View sessions:  opencode attach ${SERVER_URL}"
echo "║  Worktree:      ${WORKTREE_DIR}"
echo "║  Clean up:      git worktree remove ${WORKTREE_DIR}"
echo "╚═══════════════════════════════════════════════════════╝"
