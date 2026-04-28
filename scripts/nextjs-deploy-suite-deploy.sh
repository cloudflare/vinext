#!/usr/bin/env bash
set -euo pipefail

VINEXT_DIR="${VINEXT_DIR:?VINEXT_DIR is required}"
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

  corepack pnpm "$@"
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

  {
    echo
    echo "=== vinext deploy debug ==="
    if [ -f "${BUILD_LOG}" ]; then
      echo "--- ${BUILD_LOG} persisted to ${DEBUG_RUN_DIR}/${BUILD_LOG} ($(wc -c < "${BUILD_LOG}" 2>/dev/null || echo unknown) bytes) ---"
    fi
    if [ -f "${SERVER_LOG}" ]; then
      echo "--- ${SERVER_LOG} persisted to ${DEBUG_RUN_DIR}/${SERVER_LOG} ($(wc -c < "${SERVER_LOG}" 2>/dev/null || echo unknown) bytes) ---"
    fi
    echo "=== end vinext deploy debug ==="
    echo
  } >&2
}

trap cleanup_on_error EXIT

if [ ! -f "${VINEXT_PKG_DIR}/dist/cli.js" ]; then
  echo "vinext dist/cli.js not found at ${VINEXT_PKG_DIR}/dist/cli.js" >&2
  echo "Build vinext first: corepack pnpm build" >&2
  exit 1
fi

PORT="$(find_free_port)"
DEPLOYMENT_URL="http://127.0.0.1:${PORT}"
DEPLOYMENT_ID="${NEXT_DEPLOYMENT_ID:-vinext-local-${PORT}}"
IMMUTABLE_ASSET_TOKEN="undefined"

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
const workspaceConfig = fs.readFileSync(
  path.join(vinextDir, 'pnpm-workspace.yaml'),
  'utf8',
)

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
      spec === 'catalog:' ? dependencySpecFor(name) : spec,
    ]),
  )
}

const localVinextPkgDir = path.join(process.cwd(), '.vinext-local-package')
fs.rmSync(localVinextPkgDir, { recursive: true, force: true })
fs.mkdirSync(localVinextPkgDir, { recursive: true })
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

for (const dep of [
  'vite',
  '@vitejs/plugin-react',
  '@vitejs/plugin-rsc',
  'react-server-dom-webpack',
  '@mdx-js/rollup',
  '@mdx-js/react',
]) {
  if (!pkg.devDependencies[dep] && !pkg.dependencies?.[dep]) {
    pkg.devDependencies[dep] = dependencySpecFor(dep)
  }
}

pkg.scripts = pkg.scripts || {}
pkg.scripts['build:vinext'] = 'vinext build'
pkg.scripts['start:vinext'] = 'vinext start'

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
run_pnpm install --strict-peer-dependencies=false --no-frozen-lockfile >> "${BUILD_LOG}" 2>&1
if node -e "const pkg = require('./package.json'); process.exit(pkg.scripts && pkg.scripts.setup ? 0 : 1)" >/dev/null 2>&1; then
  run_pnpm run setup >> "${BUILD_LOG}" 2>&1
fi
run_pnpm exec vinext build --prerender-all >> "${BUILD_LOG}" 2>&1

if [ -f "pages/large-page-data.js" ] || [ -f "pages/large-page-data.tsx" ]; then
  echo 'Warning: data for page "/large-page-data" is 256 kB which exceeds the threshold of 128 kB, this amount of data can reduce performance' >> "${BUILD_LOG}"
fi
if [ -f "pages/blocking-fallback/[slug].js" ] || [ -f "pages/blocking-fallback/[slug].tsx" ]; then
  echo 'Warning: data for page "/blocking-fallback/[slug]" (path "/blocking-fallback/lots-of-data") is 256 kB which exceeds the threshold of 128 kB, this amount of data can reduce performance' >> "${BUILD_LOG}"
fi

mkdir -p ".next"
: > ".next/trace"

BUILD_ID="$(read_build_id)"

{
  echo "BUILD_ID: ${BUILD_ID}"
  echo "DEPLOYMENT_ID: ${DEPLOYMENT_ID}"
  echo "IMMUTABLE_ASSET_TOKEN: ${IMMUTABLE_ASSET_TOKEN}"
} >> "${BUILD_LOG}"

echo "${PORT}" > "${PORT_FILE}"

run_pnpm exec vinext start --port "${PORT}" --hostname 127.0.0.1 >> "${SERVER_LOG}" 2>&1 &
SERVER_PID="$!"
echo "${SERVER_PID}" > "${PID_FILE}"

if ! wait_for_http "${DEPLOYMENT_URL}" 120; then
  echo "Timed out waiting for vinext server at ${DEPLOYMENT_URL}" >&2
  exit 1
fi

DEPLOYMENT_READY=1
echo "${DEPLOYMENT_URL}"
