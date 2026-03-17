#!/bin/bash
set -euo pipefail

# Run the core vinext tests that could regress from implementation changes.
# Suppress verbose output — only errors matter.

echo "Running core test suite for regression check..."

# Key test files that cover the areas most likely to be affected by
# implementation fixes discovered during compat test porting:
pnpm test \
  tests/routing.test.ts \
  tests/shims.test.ts \
  tests/app-router.test.ts \
  tests/error-boundary.test.ts \
  tests/features.test.ts \
  --reporter=dot 2>&1 | tail -20

echo "Core tests passed."
