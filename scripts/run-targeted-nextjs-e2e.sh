#!/usr/bin/env bash
set -euo pipefail

EXAMPLE='REPO=/path/to/vinext-worktree NEXTJS_DIR=/path/to/vinext/.nextjs-ref '"$0"' test/e2e/app-dir/app-basepath/index.test.ts'

if [ -z "${REPO:-}" ]; then
  echo "Missing REPO. Set it to your vinext checkout/worktree path." >&2
  echo "Example: ${EXAMPLE}" >&2
  exit 1
fi

if [ -z "${NEXTJS_DIR:-}" ]; then
  echo "Missing NEXTJS_DIR. Set it to your prepared Next.js checkout path." >&2
  echo "Example: ${EXAMPLE}" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  echo "Usage: REPO=/path/to/vinext-worktree NEXTJS_DIR=/path/to/vinext/.nextjs-ref $0 test/e2e/app-dir/some-suite/suite.test.ts [extra run-tests args]" >&2
  echo "Example: ${EXAMPLE}" >&2
  exit 1
fi

if [ ! -d "$REPO" ]; then
  echo "REPO does not exist: $REPO" >&2
  exit 1
fi

if [ ! -f "$REPO/scripts/run-nextjs-deploy-suite.sh" ]; then
  echo "REPO does not look like vinext: $REPO" >&2
  exit 1
fi

if [ ! -f "$NEXTJS_DIR/run-tests.js" ]; then
  echo "NEXTJS_DIR does not look like a Next.js checkout: $NEXTJS_DIR" >&2
  exit 1
fi

cd "$REPO"

NEXTJS_PREPARE="${NEXTJS_PREPARE:-0}" \
VINEXT_BUILD="${VINEXT_BUILD:-1}" \
NEXT_TEST_CONCURRENCY="${NEXT_TEST_CONCURRENCY:-1}" \
vp env exec --node 24 \
  ./scripts/run-nextjs-deploy-suite.sh \
  "$NEXTJS_DIR" \
  --retries 0 \
  -c "${NEXT_TEST_CONCURRENCY:-1}" \
  --debug \
  "$@"
