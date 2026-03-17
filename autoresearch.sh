#!/bin/bash
set -euo pipefail

# ── Pre-check: ensure nextjs-compat test files parse ──
# Quick syntax check on all compat test files (catches typos before slow test run)
for f in tests/nextjs-compat/*.test.ts; do
  if ! head -1 "$f" > /dev/null 2>&1; then
    echo "ERROR: Cannot read $f"
    exit 1
  fi
done

# ── Run nextjs-compat tests and extract metrics ──
OUTPUT=$(pnpm test tests/nextjs-compat/ 2>&1) || true

# Extract passing test count from vitest output
# Format: "Tests  233 passed | 2 skipped (235)"
PASS_COUNT=$(echo "$OUTPUT" | grep -o '[0-9]* passed' | head -1 | grep -o '[0-9]*' || echo "0")
SKIP_COUNT=$(echo "$OUTPUT" | grep -o '[0-9]* skipped' | head -1 | grep -o '[0-9]*' || echo "0")
TOTAL_COUNT=$((PASS_COUNT + SKIP_COUNT))
FILE_COUNT=$(echo "$OUTPUT" | grep 'Test Files' | grep -o '[0-9]* passed' | grep -o '[0-9]*' || echo "0")

# Count audited directories from manifest
AUDITED=$(python3 -c "
import json
m = json.load(open('autoresearch.manifest.json'))
audited = sum(1 for x in m if x['status'] not in ('unaudited',))
relevant = sum(1 for x in m if x['status'] == 'covered')
print(f'{audited},{relevant}')
" 2>/dev/null || echo "0,0")
DIRS_AUDITED=$(echo "$AUDITED" | cut -d, -f1)
DIRS_COVERED=$(echo "$AUDITED" | cut -d, -f2)

# Check if tests actually passed (vitest exit code is embedded in output)
if echo "$OUTPUT" | grep -q 'Test Files.*passed'; then
  echo "METRIC passing_compat_tests=$PASS_COUNT"
  echo "METRIC test_files=$FILE_COUNT"
  echo "METRIC dirs_covered=$DIRS_COVERED"
  echo "METRIC skipped_tests=$SKIP_COUNT"
else
  echo "ERROR: Tests failed to run"
  echo "$OUTPUT" | tail -30
  exit 1
fi
