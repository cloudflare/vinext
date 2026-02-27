#!/usr/bin/env bash
set -euo pipefail

# Run the nuqs e2e test suite against vinext (app router only).
#
# This script clones the nuqs repo, patches its Next.js e2e test app to use
# vinext instead of Next.js, then runs their Playwright tests. Only app router
# tests are run (pages router tests are stripped).
#
# Usage:
#   ./scripts/nuqs-e2e.sh              # clone main, run all app router tests
#   NUQS_REF=v2.8.8 ./scripts/nuqs-e2e.sh   # pin to a specific tag/commit
#   NUQS_DIR=/path/to/nuqs ./scripts/nuqs-e2e.sh  # reuse existing clone
#
# Environment variables:
#   NUQS_REF     Git ref to clone (default: main)
#   NUQS_DIR     Directory for the nuqs clone (default: /tmp/nuqs-e2e)
#   PORT         Dev server port (default: 3001)
#   SKIP_BUILD   Set to 1 to skip building vinext (useful if already built)
#   SKIP_CLONE   Set to 1 to reuse existing clone (re-patches files)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VINEXT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NUQS_DIR="${NUQS_DIR:-/tmp/nuqs-e2e}"
NUQS_REF="${NUQS_REF:-next}"
PORT="${PORT:-3001}"
SKIP_BUILD="${SKIP_BUILD:-0}"
SKIP_CLONE="${SKIP_CLONE:-0}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

log() { echo -e "${BOLD}=== $1 ===${NC}"; }
info() { echo -e "  $1"; }

# ─── Step 1: Build vinext ──────────────────────────────────────────────────────

if [[ "$SKIP_BUILD" != "1" ]]; then
  log "Building vinext"
  cd "$VINEXT_ROOT"
  pnpm run build
else
  info "Skipping vinext build (SKIP_BUILD=1)"
fi

# Read version info from vinext's package.json (same approach as ecosystem-run.yml)
VINEXT_PKG="$VINEXT_ROOT/packages/vinext"
VITE_VERSION=$(node -e "const p=require('$VINEXT_PKG/package.json'); console.log(p.peerDependencies.vite.replace(/^[^0-9]*/,''))")
RSC_VERSION=$(node -e "const p=require('$VINEXT_PKG/package.json'); console.log(p.dependencies['@vitejs/plugin-rsc'].replace(/^[^0-9]*/,''))")
info "vinext vite peer: $VITE_VERSION"
info "vinext RSC dep:   $RSC_VERSION"

# ─── Step 2: Clone nuqs ────────────────────────────────────────────────────────

if [[ "$SKIP_CLONE" != "1" ]]; then
  log "Cloning nuqs ($NUQS_REF)"
  rm -rf "$NUQS_DIR"
  git clone --depth 1 --branch "$NUQS_REF" https://github.com/47ng/nuqs.git "$NUQS_DIR"
else
  info "Reusing existing clone at $NUQS_DIR (SKIP_CLONE=1)"
fi

# ─── Step 3: Install nuqs dependencies ─────────────────────────────────────────

log "Installing nuqs dependencies"
cd "$NUQS_DIR"
corepack enable 2>/dev/null || true
pnpm install --frozen-lockfile=false

# ─── Step 4: Build nuqs library ────────────────────────────────────────────────

log "Building nuqs library"
pnpm --filter nuqs build

# ─── Step 5: Patch e2e-next for vinext ──────────────────────────────────────────

log "Patching e2e-next for vinext"
E2E_NEXT="$NUQS_DIR/packages/e2e/next"
cd "$E2E_NEXT"

# 5a. Create vite.config.ts
info "Creating vite.config.ts"
cat > vite.config.ts << 'VITECONF'
import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  plugins: [vinext()],
  ssr: {
    // Force nuqs and e2e-shared through Vite transform pipeline
    // so vinext's next/* aliases intercept their imports
    noExternal: ["nuqs", "e2e-shared"],
  },
});
VITECONF

# 5b. Patch playwright.config.ts to use vinext dev server
info "Patching playwright.config.ts"
cat > playwright.config.ts << PWCONF
import { configurePlaywright } from 'e2e-shared/playwright.config.ts'

export default configurePlaywright({
  startCommand: 'npx vite dev --port $PORT',
  port: $PORT,
})
PWCONF

# 5c. Patch shared.spec.ts to only run app router tests
info "Patching shared.spec.ts (app router only)"
cat > specs/shared.spec.ts << 'SPECFILE'
import { runSharedTests } from 'e2e-shared/shared.spec.ts'

// Only run app router tests. Pages router is not yet supported by vinext
// for the nuqs e2e test suite.
runSharedTests('/app', { router: 'next-app' })
SPECFILE

# 5d. Remove pages router test invocations from shared spec wrappers
info "Stripping pages router tests from specs/shared/"
node -e "
const fs = require('fs');
const path = require('path');
const dir = path.join(process.cwd(), 'specs', 'shared');
if (!fs.existsSync(dir)) process.exit(0);
let stripped = 0;
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.spec.ts'))) {
  const fp = path.join(dir, f);
  const content = fs.readFileSync(fp, 'utf8');
  // Split into blocks separated by empty lines.
  // Each test invocation is a distinct block.
  const blocks = content.split(/\n\n+/);
  const before = blocks.length;
  const filtered = blocks.filter(b =>
    !b.includes(\"'next-pages'\") && !b.includes(\"'/pages/\")
  );
  stripped += before - filtered.length;
  fs.writeFileSync(fp, filtered.join('\n\n') + '\n');
}
console.log('  Removed ' + stripped + ' pages-router test blocks');
"

# 5e. Remove src/pages/ directory (no pages router support)
info "Removing src/pages/ directory"
rm -rf src/pages

# ─── Step 6: Install vinext + deps into nuqs e2e-next ──────────────────────────

log "Installing vinext into e2e-next"
cd "$NUQS_DIR"
pnpm add --filter e2e-next \
  "vinext@file:$VINEXT_PKG" \
  "vite@$VITE_VERSION" \
  "@vitejs/plugin-rsc@$RSC_VERSION" \
  "react-server-dom-webpack@^19.2.4" \
  --no-lockfile

# ─── Step 7: Install Playwright ─────────────────────────────────────────────────

log "Installing Playwright"
cd "$E2E_NEXT"
npx playwright install chromium

# ─── Step 8: Run tests ──────────────────────────────────────────────────────────

log "Running nuqs e2e tests (app router only)"
echo ""

# Run tests, capturing exit code. We don't fail the script on test failures
# since some tests are expected to fail (vinext doesn't implement everything yet).
set +e
npx playwright test --project=chromium --reporter=list 2>&1
TEST_EXIT=$?
set -e

echo ""
if [[ $TEST_EXIT -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}All tests passed!${NC}"
else
  echo -e "${RED}${BOLD}Some tests failed (exit code: $TEST_EXIT)${NC}"
  echo -e "This is expected. vinext does not yet pass 100% of nuqs e2e tests."
  echo ""
  echo "To view the full report:"
  echo "  npx playwright show-report $E2E_NEXT/.playwright/report"
fi

exit $TEST_EXIT
