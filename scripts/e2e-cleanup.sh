#!/usr/bin/env bash
# Cleanup script for the Next.js deploy test harness.
# Called by the Next.js test runner after each test completes.
# Kills the vinext server process and persists debug logs.
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
rm -f "${PID_FILE}"

# Kill the process group if possible (handles vp exec → node → vinext chains).
# On macOS/Linux, -PID sends the signal to the entire process group.
kill -TERM "-${PID}" >/dev/null 2>&1 || kill -TERM "${PID}" >/dev/null 2>&1 || true
sleep 1
kill -KILL "-${PID}" >/dev/null 2>&1 || kill -KILL "${PID}" >/dev/null 2>&1 || true

# If a port file exists, also kill any process still listening on that port.
# This catches orphaned child processes that escaped process group signaling.
PORT_FILE=".vinext-deploy-server.port"
if [ -f "${PORT_FILE}" ]; then
  PORT="$(cat "${PORT_FILE}")"
  LISTENER_PID="$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)"
  if [ -n "${LISTENER_PID}" ]; then
    kill -TERM ${LISTENER_PID} >/dev/null 2>&1 || true
    sleep 1
    kill -KILL ${LISTENER_PID} >/dev/null 2>&1 || true
  fi
fi
