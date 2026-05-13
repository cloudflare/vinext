#!/usr/bin/env bash
set -euo pipefail

PID_FILE=".vinext-deploy-server.pid"
BUILD_LOG=".vinext-deploy-build.log"
SERVER_LOG=".vinext-deploy-server.log"
DEBUG_ROOT_DIR="${VINEXT_DEPLOY_DEBUG_DIR:-${VINEXT_DIR:-$(pwd)}/reports/nextjs-deploy-debug}"

persist_logs() {
  local debug_run_dir="${DEBUG_ROOT_DIR}/cleanup-$(date +%s)-$$"
  mkdir -p "${debug_run_dir}" 2>/dev/null || return 0
  [ -f "${BUILD_LOG}" ] && cp "${BUILD_LOG}" "${debug_run_dir}/${BUILD_LOG}" 2>/dev/null || true
  [ -f "${SERVER_LOG}" ] && cp "${SERVER_LOG}" "${debug_run_dir}/${SERVER_LOG}" 2>/dev/null || true
  {
    echo "cwd: $(pwd)"
    echo "pid_file: ${PID_FILE}"
  } > "${debug_run_dir}/context.txt" 2>/dev/null || true
}

persist_logs

if [ ! -f "${PID_FILE}" ]; then
  exit 0
fi

PID="$(cat "${PID_FILE}")"
kill -TERM "${PID}" >/dev/null 2>&1 || true
sleep 1
kill -KILL "${PID}" >/dev/null 2>&1 || true
