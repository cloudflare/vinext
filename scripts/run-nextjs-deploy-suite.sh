#!/usr/bin/env bash
# Convenience wrapper for running the Next.js deploy test suite locally.
# Handles building vinext, preparing the Next.js checkout, and invoking
# run-tests.js with the correct environment variables.
#
# Usage:
#   ./scripts/run-nextjs-deploy-suite.sh /path/to/next.js [run-tests args...]
#
# Environment variables:
#   VINEXT_BUILD=0     Skip building vinext (if already built)
#   NEXTJS_PREPARE=1   Install + build Next.js and Playwright
#   NEXTJS_PREPARE_ONLY=1  Prepare Next.js and exit (don't run tests)
#   NEXT_TEST_GROUP    Shard group (e.g. "1/16")
#   NEXT_TEST_CONCURRENCY  Parallel test count (default 2)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [ "${1:-}" != "" ] && [ "${1}" = "${1#-}" ]; then
  NEXTJS_DIR="${NEXTJS_DIR:-$1}"
  shift
else
  NEXTJS_DIR="${NEXTJS_DIR:-}"
fi

if [ -z "${NEXTJS_DIR}" ] && [ -d "${REPO_DIR}/../next.js" ]; then
  NEXTJS_DIR="${REPO_DIR}/../next.js"
fi

if [ -z "${NEXTJS_DIR}" ]; then
  echo "Usage: $0 /absolute/path/to/next.js [run-tests args...]" >&2
  echo "Or set NEXTJS_DIR to a prepared Next.js checkout." >&2
  exit 1
fi

NEXTJS_DIR="$(cd "${NEXTJS_DIR}" && pwd)"

if [ ! -f "${NEXTJS_DIR}/run-tests.js" ]; then
  echo "Could not find run-tests.js in ${NEXTJS_DIR}" >&2
  exit 1
fi

run_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
    return
  fi

  corepack pnpm "$@"
}

if [ "${VINEXT_BUILD:-1}" = "1" ]; then
  (
    cd "${REPO_DIR}"
    run_pnpm build
  )
fi

if [ "${NEXTJS_PREPARE:-0}" = "1" ]; then
  (
    cd "${NEXTJS_DIR}"
    echo ">>> $(date -Iseconds) pnpm install"
    run_pnpm install
    echo ">>> $(date -Iseconds) pnpm build"
    run_pnpm build
    echo ">>> $(date -Iseconds) pnpm playwright install"
    run_pnpm playwright install chromium chromium-headless-shell
    echo ">>> $(date -Iseconds) prepare done"
  )
fi

if [ "${NEXTJS_PREPARE_ONLY:-0}" = "1" ]; then
  exit 0
fi

export VINEXT_DIR="${VINEXT_DIR:-${REPO_DIR}}"
export ADAPTER_DIR="${ADAPTER_DIR:-${REPO_DIR}}"
export NEXT_TEST_MODE="${NEXT_TEST_MODE:-deploy}"
export NEXT_E2E_TEST_TIMEOUT="${NEXT_E2E_TEST_TIMEOUT:-240000}"
export NEXT_EXTERNAL_TESTS_FILTERS="${NEXT_EXTERNAL_TESTS_FILTERS:-test/deploy-tests-manifest.json}"
export NEXT_TEST_JOB="${NEXT_TEST_JOB:-1}"
export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"
export IS_TURBOPACK_TEST="${IS_TURBOPACK_TEST:-1}"
export NEXT_TEST_DEPLOY_SCRIPT_PATH="${REPO_DIR}/scripts/e2e-deploy.sh"
export NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH="${REPO_DIR}/scripts/e2e-logs.sh"
export NEXT_TEST_CLEANUP_SCRIPT_PATH="${REPO_DIR}/scripts/e2e-cleanup.sh"

RUN_ARGS=(--timings --type e2e)

if [ "$#" -eq 0 ]; then
  TEST_GROUP="${NEXT_TEST_GROUP-1/16}"
  TEST_CONCURRENCY="${NEXT_TEST_CONCURRENCY-2}"

  if [ -n "${TEST_GROUP}" ]; then
    RUN_ARGS+=(-g "${TEST_GROUP}")
  fi

  if [ -n "${TEST_CONCURRENCY}" ]; then
    RUN_ARGS+=(-c "${TEST_CONCURRENCY}")
  fi
fi

if [ "$#" -gt 0 ]; then
  RUN_ARGS+=("$@")
fi

(
  cd "${NEXTJS_DIR}"
  node run-tests.js "${RUN_ARGS[@]}"
)
