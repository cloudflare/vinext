#!/usr/bin/env bash
# Deploy script for the Next.js deploy test harness.
# Called by the Next.js test runner (run-tests.js) for each isolated test app.
#
# Contract (per https://nextjs.org/docs/app/api-reference/adapters/testing-adapters):
# - cwd is the isolated test app directory
# - Must print the deployment URL to stdout (nothing else on stdout)
# - Must exit non-zero on failure
# - Diagnostic output goes to stderr or files in the working directory
#
# This script injects vinext as a local file dependency into the test app,
# builds with `vinext build`, starts with `vinext start`, and prints the URL.
set -euo pipefail

# Accept ADAPTER_DIR (Next.js docs convention) or VINEXT_DIR
VINEXT_DIR="${VINEXT_DIR:-${ADAPTER_DIR:-}}"
if [ -z "${VINEXT_DIR}" ]; then
  echo "Either VINEXT_DIR or ADAPTER_DIR must be set" >&2
  exit 1
fi
VINEXT_DIR="$(cd "${VINEXT_DIR}" && pwd)"
VINEXT_PKG_DIR="${VINEXT_PKG_DIR:-${VINEXT_DIR}/packages/vinext}"
VINEXT_PKG_DIR="$(cd "${VINEXT_PKG_DIR}" && pwd)"

BUILD_LOG=".vinext-deploy-build.log"
SERVER_LOG=".vinext-deploy-server.log"
PID_FILE=".vinext-deploy-server.pid"
PORT_FILE=".vinext-deploy-server.port"
DEBUG_ROOT_DIR="${VINEXT_DEPLOY_DEBUG_DIR:-${VINEXT_DIR}/reports/nextjs-deploy-debug}"
DEBUG_RUN_DIR="${DEBUG_ROOT_DIR}/$(date +%s)-$$"

DEPLOYMENT_READY=0

persist_debug_artifacts() {
  mkdir -p "${DEBUG_RUN_DIR}"

  if [ -f "package.json" ]; then
    cp "package.json" "${DEBUG_RUN_DIR}/package.json"
  fi

  if [ -f "${BUILD_LOG}" ]; then
    cp "${BUILD_LOG}" "${DEBUG_RUN_DIR}/${BUILD_LOG}"
  fi

  if [ -f "${SERVER_LOG}" ]; then
    cp "${SERVER_LOG}" "${DEBUG_RUN_DIR}/${SERVER_LOG}"
  fi

  if [ -f "dist/server/entry.js" ]; then
    mkdir -p "${DEBUG_RUN_DIR}/dist/server"
    cp "dist/server/entry.js" "${DEBUG_RUN_DIR}/dist/server/entry.js"
  fi

  if [ -f "dist/server/index.mjs" ]; then
    mkdir -p "${DEBUG_RUN_DIR}/dist/server"
    cp "dist/server/index.mjs" "${DEBUG_RUN_DIR}/dist/server/index.mjs"
  fi

  {
    echo "cwd: $(pwd)"
    echo "next_test_dir: ${NEXT_TEST_DIR:-unknown}"
    echo "deploy_url: ${DEPLOYMENT_URL:-unknown}"
    if [ -d "dist" ]; then
      echo "--- dist files ---"
      find "dist" -maxdepth 4 -type f | sort
    fi
  } > "${DEBUG_RUN_DIR}/context.txt"
}

run_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
    return
  fi

  if command -v corepack >/dev/null 2>&1; then
    corepack pnpm "$@"
    return
  fi

  # Vite+ (vp) environments expose vp instead of pnpm. The subcommand
  # names (install, run, exec) are the same, but pnpm-specific flags
  # must be forwarded as pass-through args.
  if command -v vp >/dev/null 2>&1; then
    local subcmd="$1"
    shift

    if [ "${subcmd}" = "install" ]; then
      local vp_args=()
      local passthrough_args=()

      for arg in "$@"; do
        case "${arg}" in
          --no-frozen-lockfile) vp_args+=("${arg}") ;;
          --strict-peer-dependencies=*) passthrough_args+=("${arg}") ;;
          *) vp_args+=("${arg}") ;;
        esac
      done

      if [ ${#passthrough_args[@]} -gt 0 ]; then
        vp install "${vp_args[@]}" -- "${passthrough_args[@]}"
      else
        vp install "${vp_args[@]}"
      fi
    else
      vp "${subcmd}" "$@"
    fi
    return
  fi

  echo "No package manager found (tried pnpm, corepack, vp)" >&2
  exit 1
}

find_free_port() {
  node <<'EOF'
const net = require('node:net')

const server = net.createServer()
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (!address || typeof address !== 'object') {
    console.error('Failed to allocate a free port')
    process.exit(1)
  }

  console.log(address.port)
  server.close()
})
EOF
}

wait_for_http() {
  local url="$1"
  local attempts="${2:-120}"

  for _ in $(seq 1 "${attempts}"); do
    local status
    status="$(curl -s -o /dev/null -w '%{http_code}' "${url}" || true)"
    if [ -n "${status}" ] && [ "${status}" != "000" ]; then
      return 0
    fi
    sleep 1
  done

  return 1
}

ensure_python_command_for_native_builds() {
  if command -v python >/dev/null 2>&1; then
    return
  fi

  local python3_bin
  python3_bin="$(command -v python3 || true)"
  if [ -z "${python3_bin}" ]; then
    return
  fi

  local shim_dir=".vinext-native-build-bin"
  mkdir -p "${shim_dir}"
  ln -sf "${python3_bin}" "${shim_dir}/python"
  export PATH="$(pwd)/${shim_dir}:${PATH}"
  echo "Added python -> ${python3_bin} shim for native addon builds" >> "${BUILD_LOG}"
}

detach_symlinked_node_modules() {
  if [ ! -L "node_modules" ]; then
    return
  fi

  local target
  target="$(readlink "node_modules" || true)"
  rm -f "node_modules"
  echo "Detached symlinked node_modules${target:+ -> ${target}} before install; pnpm will create a local modules directory." >> "${BUILD_LOG}"
}

read_build_id() {
  if [ -f "dist/server/BUILD_ID" ]; then
    cat "dist/server/BUILD_ID"
    return 0
  fi

  node <<'EOF'
const fs = require('node:fs')

const bundlePath = [
  'dist/server/index.mjs',
  'dist/server/index.js',
  'dist/server/entry.mjs',
  'dist/server/entry.js',
].find((candidate) => fs.existsSync(candidate))
if (!bundlePath) {
  console.error('Missing dist/server/index.{js,mjs} and dist/server/entry.{js,mjs}')
  process.exit(1)
}

const code = fs.readFileSync(bundlePath, 'utf8')
const match =
  code.match(/get buildId\(\)\s*\{\s*return "([^"]+)"/) ||
  code.match(/\bbuildId\s*=\s*"([^"]+)"/)
if (!match) {
  console.error(`Failed to extract build ID from ${bundlePath}`)
  process.exit(1)
}

console.log(match[1])
EOF
}

cleanup_on_error() {
  if [ "${DEPLOYMENT_READY}" = "1" ]; then
    return
  fi

  persist_debug_artifacts

  if [ -f "${PID_FILE}" ]; then
    local pid
    pid="$(cat "${PID_FILE}")"
    kill -TERM "${pid}" >/dev/null 2>&1 || true
    sleep 1
    kill -KILL "${pid}" >/dev/null 2>&1 || true
  fi

  # Kill any process still listening on the allocated port (handles orphaned children).
  # Read from PORT_FILE rather than $PORT since the variable may not be set if
  # the script failed before port allocation.
  if [ -f "${PORT_FILE}" ]; then
    local cleanup_port
    cleanup_port="$(cat "${PORT_FILE}")"
    local listener_pid
    listener_pid="$(lsof -ti "tcp:${cleanup_port}" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "${listener_pid}" ]; then
      kill -TERM ${listener_pid} >/dev/null 2>&1 || true
      sleep 1
      kill -KILL ${listener_pid} >/dev/null 2>&1 || true
    fi
  fi

  {
    echo
    echo "=== vinext deploy debug ==="
    if [ -f "${BUILD_LOG}" ]; then
      echo "--- last 80 lines of ${BUILD_LOG} ---"
      tail -80 "${BUILD_LOG}" 2>/dev/null || true
      echo "--- end ${BUILD_LOG} (persisted to ${DEBUG_RUN_DIR}/${BUILD_LOG}) ---"
    fi
    if [ -f "${SERVER_LOG}" ]; then
      echo "--- last 40 lines of ${SERVER_LOG} ---"
      tail -40 "${SERVER_LOG}" 2>/dev/null || true
      echo "--- end ${SERVER_LOG} (persisted to ${DEBUG_RUN_DIR}/${SERVER_LOG}) ---"
    fi
    echo "=== end vinext deploy debug ==="
    echo
  } >&2
}

trap cleanup_on_error EXIT

# Some Next.js tests check for .next/trace existence (telemetry trace file)
# during the test harness's destroy() cleanup. vinext doesn't produce one, so
# create an empty file to satisfy those checks. Do this BEFORE any step that
# can fail (dep install, vinext init, vinext build) so the file exists even
# on failure — otherwise the test harness logs ENOENT noise (303 lines per
# deploy-suite run before this fix).
mkdir -p ".next"
: > ".next/trace"

if [ ! -f "${VINEXT_PKG_DIR}/dist/cli.js" ]; then
  echo "vinext dist/cli.js not found at ${VINEXT_PKG_DIR}/dist/cli.js" >&2
  echo "Build vinext first: corepack pnpm build" >&2
  exit 1
fi

PORT="$(find_free_port)"
DEPLOYMENT_URL="http://127.0.0.1:${PORT}"
DEPLOYMENT_ID="${NEXT_DEPLOYMENT_ID:-vinext-local-${PORT}}"

{
  echo "vinext dir: ${VINEXT_DIR}"
  echo "vinext package dir: ${VINEXT_PKG_DIR}"
  echo "deploy url: ${DEPLOYMENT_URL}"
  echo "deployment id: ${DEPLOYMENT_ID}"
  echo "next test dir: ${NEXT_TEST_DIR:-unknown}"
} > "${BUILD_LOG}"

node <<'EOF' >> "${BUILD_LOG}" 2>&1
const fs = require('node:fs')
const path = require('node:path')

const vinextDir = process.env.VINEXT_DIR
const pkgPath = path.join(process.cwd(), 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const rootPkg = JSON.parse(fs.readFileSync(path.join(vinextDir, 'package.json'), 'utf8'))
const vinextPkg = JSON.parse(
  fs.readFileSync(path.join(vinextDir, 'packages', 'vinext', 'package.json'), 'utf8'),
)
const cloudflarePkg = JSON.parse(
  fs.readFileSync(path.join(vinextDir, 'packages', 'cloudflare', 'package.json'), 'utf8'),
)
const workspaceConfig = fs.readFileSync(
  path.join(vinextDir, 'pnpm-workspace.yaml'),
  'utf8',
)

// The deploy adapter always installs with pnpm below. Some Next.js fixtures pin
// packageManager to npm/yarn/bun to exercise Next's own install command, but
// pnpm refuses to run in those projects before it can link vinext.
const originalPackageManager =
  typeof pkg.packageManager === 'string' && pkg.packageManager.length > 0
    ? pkg.packageManager
    : null
const harnessPackageManager =
  typeof rootPkg.packageManager === 'string' && rootPkg.packageManager.length > 0
    ? rootPkg.packageManager
    : 'pnpm@11.1.1'
if (originalPackageManager && !originalPackageManager.startsWith('pnpm@')) {
  pkg.packageManager = harnessPackageManager
  console.log(
    `Replaced packageManager ${originalPackageManager} with ${harnessPackageManager} for vinext deploy harness pnpm install`,
  )
}

// Minimal YAML parser for the pnpm workspace catalog. Assumes the simple
// block mapping format used in this repo's pnpm-workspace.yaml (2-space
// indent, no flow syntax, no nested catalogs). This avoids pulling in a
// YAML parser dependency in the throwaway test app temp directories.
function parseCatalog(yaml) {
  const catalog = {}
  let inCatalog = false

  for (const line of yaml.split(/\r?\n/)) {
    if (!inCatalog) {
      if (line.trim() === 'catalog:') {
        inCatalog = true
      }
      continue
    }

    if (!line.startsWith('  ')) {
      break
    }

    const match = line.match(/^\s{2}(?:"([^"]+)"|([^:]+)):\s+(.+)$/)
    if (!match) {
      continue
    }

    const name = match[1] || match[2]
    const spec = match[3].trim()
    catalog[name] = spec
  }

  return catalog
}

const catalog = parseCatalog(workspaceConfig)
const localCloudflarePkgDir = path.join(process.cwd(), '.vinext-local-cloudflare-package')

function workspaceDependencySpecFor(name) {
  if (name === cloudflarePkg.name) {
    return 'file:../.vinext-local-cloudflare-package'
  }

  throw new Error(`Unable to resolve workspace dependency spec for ${name}`)
}

function dependencySpecFor(name) {
  for (const deps of [
    vinextPkg.peerDependencies,
    vinextPkg.dependencies,
    vinextPkg.devDependencies,
    rootPkg.dependencies,
    rootPkg.devDependencies,
  ]) {
    const spec = deps?.[name]
    if (!spec) continue
    if (spec.startsWith('workspace:')) return workspaceDependencySpecFor(name)
    if (spec !== 'catalog:') return spec
    if (catalog[name]) return catalog[name]
  }

  if (catalog[name]) {
    return catalog[name]
  }

  throw new Error(`Unable to resolve dependency spec for ${name}`)
}

function resolveManifestDeps(deps) {
  if (!deps) return undefined

  return Object.fromEntries(
    Object.entries(deps).map(([name, spec]) => [
      name,
      spec === 'catalog:' || spec.startsWith('workspace:') ? dependencySpecFor(name) : spec,
    ]),
  )
}

const localVinextPkgDir = path.join(process.cwd(), '.vinext-local-package')
fs.rmSync(localVinextPkgDir, { recursive: true, force: true })
fs.rmSync(localCloudflarePkgDir, { recursive: true, force: true })
fs.mkdirSync(localVinextPkgDir, { recursive: true })
fs.mkdirSync(localCloudflarePkgDir, { recursive: true })
fs.cpSync(
  path.join(vinextDir, 'packages', 'cloudflare', 'dist'),
  path.join(localCloudflarePkgDir, 'dist'),
  {
    recursive: true,
  },
)
fs.writeFileSync(
  path.join(localCloudflarePkgDir, 'package.json'),
  JSON.stringify(
    {
      name: cloudflarePkg.name,
      version: cloudflarePkg.version,
      description: cloudflarePkg.description,
      license: cloudflarePkg.license,
      repository: cloudflarePkg.repository,
      type: cloudflarePkg.type,
      files: ['dist'],
      exports: cloudflarePkg.exports,
      peerDependencies: resolveManifestDeps(cloudflarePkg.peerDependencies),
      engines: cloudflarePkg.engines,
    },
    null,
    2,
  ) + '\n',
)
fs.cpSync(path.join(vinextDir, 'packages', 'vinext', 'dist'), path.join(localVinextPkgDir, 'dist'), {
  recursive: true,
})
fs.writeFileSync(
  path.join(localVinextPkgDir, 'package.json'),
  JSON.stringify(
    {
      name: vinextPkg.name,
      version: vinextPkg.version,
      description: vinextPkg.description,
      license: vinextPkg.license,
      repository: vinextPkg.repository,
      type: vinextPkg.type,
      main: vinextPkg.main,
      types: vinextPkg.types,
      bin: vinextPkg.bin,
      files: ['dist'],
      exports: vinextPkg.exports,
      dependencies: resolveManifestDeps(vinextPkg.dependencies),
      peerDependencies: resolveManifestDeps(vinextPkg.peerDependencies),
      peerDependenciesMeta: vinextPkg.peerDependenciesMeta,
      engines: vinextPkg.engines,
    },
    null,
    2,
  ) + '\n',
)

pkg.devDependencies = pkg.devDependencies || {}
pkg.devDependencies.vinext = 'file:.vinext-local-package'

// App Router fixtures need React to satisfy the same peer range as the
// injected react-server-dom-webpack. If they install an older React pair first,
// `vinext build` runs its RSC compatibility upgrade and pays for a second
// package-manager install inside every throwaway test app. Normalize the temp
// manifest before the first install so the final dependency graph is unchanged
// but setup is single-pass.
function hasAppRouterDir(root) {
  return fs.existsSync(path.join(root, 'app')) || fs.existsSync(path.join(root, 'src', 'app'))
}

function compareSemver(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] < b[index]) return -1
    if (a[index] > b[index]) return 1
  }

  return 0
}

function parseSemverSpec(spec) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(spec)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function dependencyBucketFor(name) {
  for (const bucket of ['dependencies', 'devDependencies', 'peerDependencies']) {
    if (pkg[bucket]?.[name]) return bucket
  }

  return null
}

function normalizeAppRouterReactDeps() {
  if (!hasAppRouterDir(process.cwd())) return

  for (const dep of ['react', 'react-dom']) {
    const bucket = dependencyBucketFor(dep)
    if (!bucket) continue

    const current = pkg[bucket][dep]
    const version = parseSemverSpec(current)
    const replacement = dependencySpecFor(dep)
    const minimumVersion = parseSemverSpec(replacement)
    if (!minimumVersion) continue
    if (!version || compareSemver(version, minimumVersion) >= 0) continue

    pkg[bucket][dep] = replacement
    console.log(
      `Bumped ${bucket}.${dep} from ${current} to ${replacement} for RSC compatibility`,
    )
  }
}

normalizeAppRouterReactDeps()

// Catalog-tracked deps: spec sourced from vinext or workspace root package.json.
// Includes the Vite/RSC peers that vinext consumers must install, plus runtime
// deps of vinext that pnpm doesn't hoist into the test app's top-level
// node_modules (vinext is installed via a `file:` symlink, so its transitive
// deps live under `.vinext-local-package/node_modules`, which Node's ESM
// resolver can't see from `<test-app>/dist/...`).
for (const dep of [
  'vite',
  '@vitejs/plugin-react',
  '@vitejs/plugin-rsc',
  'react-server-dom-webpack',
  '@mdx-js/rollup',
  '@mdx-js/react',
  'ipaddr.js',
]) {
  if (!pkg.devDependencies[dep] && !pkg.dependencies?.[dep]) {
    pkg.devDependencies[dep] = dependencySpecFor(dep)
  }
}

// Some Next.js scss test fixtures pin sass to an old version (e.g. 1.54.0)
// that predates `sass.initAsyncCompiler`. Vite 8's built-in vite:css preprocessor
// calls that API and declares `sass@^1.70.0` / `sass-embedded@^1.70.0` as peers.
// If the test app pins a sass/sass-embedded version below the Vite 8 peer range,
// bump it so the SCSS preprocessor can initialise. This is the minimum bump that
// keeps the test app's intent (use sass) while making Vite happy. Without it,
// every test/e2e/app-dir/scss/* and test/e2e/app-dir/scss-modules/* suite fails
// at build time with: TypeError: [sass] sass.initAsyncCompiler is not a function.
//
// Parses the leading `major.minor` out of pinned specs like "1.54.0", "^1.70.0",
// "~1.75.0", ">=1.70.0". Falls through (no rewrite) for git/file/workspace/tag
// specs, which never come from the Next.js test fixtures we're patching here.
function parseMajorMinor(spec) {
  const match = /^[\^~>=<\s]*(\d+)\.(\d+)/.exec(spec)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]) }
}

function bumpSassDep(name, minSpec) {
  for (const bucket of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[bucket]
    if (!deps || !deps[name]) continue
    const current = deps[name]
    const version = parseMajorMinor(current)
    if (!version) continue
    if (version.major > 1 || (version.major === 1 && version.minor >= 70)) {
      continue
    }
    deps[name] = minSpec
    console.log(
      `Bumped ${bucket}.${name} from ${current} to ${minSpec} for Vite 8 compatibility`,
    )
  }
}

bumpSassDep('sass', '^1.70.0')
bumpSassDep('sass-embedded', '^1.70.0')

// Pinned harness-only deps that aren't tracked by the vinext workspace but
// are referenced by Next.js test fixtures. `webpack` is imported at module
// scope by test/e2e/app-dir/next-config/next.config.js (top-level
// `require('webpack').sources.RawSource`) — Next.js's own test harness gets
// it transitively via `next`, but the test fixture's package.json doesn't
// declare it, so vinext's build fails to resolve it after the CJS→ESM rewrite.
for (const [dep, spec] of [
  ['webpack', '^5.99.0'],
]) {
  if (!pkg.devDependencies[dep] && !pkg.dependencies?.[dep]) {
    pkg.devDependencies[dep] = spec
  }
}

// Detect TypeScript config files. Vite's PostCSS/Tailwind/etc. config loaders
// require either `jiti` or `tsx` to load `*.config.{ts,mts,cts}` (and dotfile
// `.postcssrc.ts` variants). Next.js used to auto-install one of these into
// the test app at build time; once vinext takes over, the test app's
// package.json no longer lists either, so the build fails with:
//
//   'tsx' or 'jiti' is required for the TypeScript configuration files.
//   Make sure it is installed
//   Cannot find package 'jiti' imported from .../vite/dist/node/chunks/node.js
//
// jiti is the lighter of the two (no native deps) and matches what Vite's
// internal config loader prefers, so inject jiti when any TS-flavoured config
// file is present at the test app root.
const tsConfigFilePatterns = [
  /^next\.config\.(?:ts|mts|cts)$/,
  /^postcss\.config\.(?:ts|mts|cts)$/,
  /^tailwind\.config\.(?:ts|mts|cts)$/,
  /^vite\.config\.(?:ts|mts|cts)$/,
  /^\.postcssrc\.(?:ts|mts|cts)$/,
]
let hasTsConfig = false
try {
  const entries = fs.readdirSync(process.cwd(), { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (tsConfigFilePatterns.some((rx) => rx.test(entry.name))) {
      hasTsConfig = true
      break
    }
  }
} catch {
  // ignore — fall back to not injecting jiti
}

if (hasTsConfig && !pkg.devDependencies.jiti && !pkg.dependencies?.jiti) {
  // Pin matches the version already resolved transitively in the vinext
  // workspace (via @tailwindcss/node). postcss-load-config and Vite both
  // require jiti >=1.21.0; ^2.6.1 satisfies that.
  pkg.devDependencies.jiti = '^2.6.1'
}

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log('Injected vinext harness dependencies into package.json')
EOF

export CI=1
export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"
export NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID}"
export VINEXT_NEXT_DEPLOY_CACHE_CONTROL=1
export HOST="127.0.0.1"
export PORT="${PORT}"

ensure_python_command_for_native_builds

# pnpm 10+ exits non-zero when dependencies have unapproved build scripts
# (ERR_PNPM_IGNORED_BUILDS). The install still completes — packages are
# written to node_modules — but the exit code is 1. Tolerate this by
# verifying that the vinext local package was linked into node_modules.
INSTALL_LOG="$(mktemp)"
detach_symlinked_node_modules
run_pnpm install --strict-peer-dependencies=false --no-frozen-lockfile > "${INSTALL_LOG}" 2>&1 || true
# Dependency-manager deprecation summaries describe the deploy harness's own
# transitive dependencies, not the application under test. Keep the rest of
# the install output available for diagnostics without polluting cliOutput
# assertions that specifically inspect application deprecation warnings.
"${VINEXT_DIR}/scripts/filter-e2e-install-log.sh" < "${INSTALL_LOG}" >> "${BUILD_LOG}"
rm -f "${INSTALL_LOG}"
if [ ! -d "node_modules/vinext" ]; then
  echo "pnpm install failed: node_modules/vinext not found" >&2
  exit 1
fi
VINEXT_BIN="./node_modules/.bin/vinext"
if [ ! -x "${VINEXT_BIN}" ]; then
  echo "pnpm install failed: ${VINEXT_BIN} not found or not executable" >&2
  exit 1
fi
if node -e "const pkg = require('./package.json'); process.exit(pkg.scripts && pkg.scripts.setup ? 0 : 1)" >/dev/null 2>&1; then
  run_pnpm run setup >> "${BUILD_LOG}" 2>&1
fi

# Run vinext init to set up the project for vinext: adds "type": "module",
# renames CJS configs to .cjs, and generates vite.config.ts.
# --skip-check avoids the interactive compat report, --force overwrites any
# existing vite.config.ts. Dep installation is a no-op since we already injected
# them above.
#
# vinext loads CJS next.config.js in `"type": "module"` packages via a temp
# .cjs sibling (see config/next-config.ts), so we don't rewrite the user's
# config file here.
"${VINEXT_BIN}" init --platform=node --skip-check --force >> "${BUILD_LOG}" 2>&1

"${VINEXT_BIN}" build --prerender-all >> "${BUILD_LOG}" 2>&1

# Next.js emits large-page-data warnings during build. Specific deploy tests
# (e.g. test/e2e/prerender) assert these strings appear in the build output,
# so we synthesize them here since vinext doesn't have the same threshold check.
if [ -f "pages/large-page-data.js" ] || [ -f "pages/large-page-data.tsx" ]; then
  echo 'Warning: data for page "/large-page-data" is 256 kB which exceeds the threshold of 128 kB, this amount of data can reduce performance' >> "${BUILD_LOG}"
fi
if [ -f "pages/blocking-fallback/[slug].js" ] || [ -f "pages/blocking-fallback/[slug].tsx" ]; then
  echo 'Warning: data for page "/blocking-fallback/[slug]" (path "/blocking-fallback/lots-of-data") is 256 kB which exceeds the threshold of 128 kB, this amount of data can reduce performance' >> "${BUILD_LOG}"
fi

BUILD_ID="$(read_build_id)"

# The Next.js test harness parses these markers from the logs script output
# (see next-deploy.ts parseIdsFromCliOuput). All three are required.
# v16.2.x uses IMMUTABLE_ASSET_TOKEN; canary renamed it to
# NEXT_SUPPORTS_IMMUTABLE_ASSETS. Emit both for cross-version compat.
{
  echo "BUILD_ID: ${BUILD_ID}"
  echo "DEPLOYMENT_ID: ${DEPLOYMENT_ID}"
  echo "IMMUTABLE_ASSET_TOKEN: undefined"
  echo "NEXT_SUPPORTS_IMMUTABLE_ASSETS: 0"
} >> "${BUILD_LOG}"

echo "${PORT}" > "${PORT_FILE}"

"${VINEXT_BIN}" start --port "${PORT}" --hostname 127.0.0.1 >> "${SERVER_LOG}" 2>&1 &
SERVER_PID="$!"
echo "${SERVER_PID}" > "${PID_FILE}"

if ! wait_for_http "${DEPLOYMENT_URL}" 120; then
  echo "Timed out waiting for vinext server at ${DEPLOYMENT_URL}" >&2
  exit 1
fi

DEPLOYMENT_READY=1
echo "${DEPLOYMENT_URL}"
