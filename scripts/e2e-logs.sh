#!/usr/bin/env bash
# Logs script for the Next.js deploy test harness.
# Called by the Next.js test runner after deploying each test app.
# Output must include BUILD_ID:, DEPLOYMENT_ID:, and IMMUTABLE_ASSET_TOKEN:
# lines (these are written to .vinext-deploy-build.log by e2e-deploy.sh).
set -euo pipefail

BUILD_LOG=".vinext-deploy-build.log"
SERVER_LOG=".vinext-deploy-server.log"

if [ -f "${BUILD_LOG}" ]; then
  cat "${BUILD_LOG}"
fi

if [ -f "${SERVER_LOG}" ]; then
  echo "=== ${SERVER_LOG} ==="
  cat "${SERVER_LOG}"
fi
