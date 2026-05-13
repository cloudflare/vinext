#!/usr/bin/env bash
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
