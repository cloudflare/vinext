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
    kill -TERM "-${pid}" >/dev/null 2>&1 || kill -TERM "${pid}" >/dev/null 2>&1 || true
    sleep 1
    kill -KILL "-${pid}" >/dev/null 2>&1 || kill -KILL "${pid}" >/dev/null 2>&1 || true
  fi

  # Kill any process still listening on the allocated port (handles orphaned children).
  # Read from PORT_FILE rather than $PORT since the variable may not be set if
  # the script failed before port allocation.
  if [ -f "${PORT_FILE}" ]; then
    local cleanup_port
    cleanup_port="$(cat "${PORT_FILE}")"
    local listener_pid
    listener_pid="$(lsof -ti "tcp:${cleanup_port}" 2>/dev/null || true)"
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
const workspaceConfig = fs.readFileSync(
  path.join(vinextDir, 'pnpm-workspace.yaml'),
  'utf8',
)

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
run_pnpm install --strict-peer-dependencies=false --no-frozen-lockfile >> "${BUILD_LOG}" 2>&1 || true
if [ ! -d "node_modules/vinext" ]; then
  echo "pnpm install failed: node_modules/vinext not found" >&2
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
run_pnpm exec vinext init --skip-check --force >> "${BUILD_LOG}" 2>&1

# After vinext init adds "type": "module", any CJS next.config.{js,ts} will
# fail because Node.js treats .js as ESM. We can't rename to .cjs (Next.js
# doesn't support it), so convert CJS syntax to ESM in-place. vinext init
# handles other config files (postcss, tailwind, etc.) by renaming to .cjs.
#
# The converter handles:
#   module.exports = X              → export default X
#   const X = require('mod')        → import X from 'mod'
#   const X = require('mod')(args)  → import _X from 'mod'; const X = _X(args)
#   require('mod') in expressions   → (await import('mod')).default
for config_file in next.config.js next.config.ts; do
  if [ -f "${config_file}" ]; then
    node -e '
      const fs = require("node:fs");
      const f = process.argv[1];
      let c = fs.readFileSync(f, "utf8");
      if (!/\bmodule\.exports\b/.test(c) && !/\brequire\s*\(/.test(c)) process.exit(0);

      const imports = [];
      let counter = 0;

      // 1. const X = require("mod")(args) → import + const X = _mod(args)
      c = c.replace(
        /\b(const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*(["'"'"'][^"'"'"']+["'"'"'])\s*\)\s*(\([^)]*\))/g,
        (_, decl, name, mod, call) => {
          const alias = `_cjsImport${counter++}`;
          imports.push(`import ${alias} from ${mod};`);
          return `${decl} ${name} = ${alias}${call}`;
        }
      );

      // 2. const X = require("mod") → import X from "mod"
      c = c.replace(
        /\b(const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*(["'"'"'][^"'"'"']+["'"'"'])\s*\)/g,
        (_, _decl, name, mod) => {
          imports.push(`import ${name} from ${mod};`);
          return "";
        }
      );

      // 2b. const { a, b } = require("mod") → import { a, b } from "mod"
      c = c.replace(
        /\b(const|let|var)\s+(\{[^}]+\})\s*=\s*require\s*\(\s*(["'"'"'][^"'"'"']+["'"'"'])\s*\)/g,
        (_, _decl, destructured, mod) => {
          imports.push(`import ${destructured} from ${mod};`);
          return "";
        }
      );

      // 3. Remaining require("mod") in expressions → (await import("mod")).default
      // TODO: This doesn't perfectly handle all CJS patterns (e.g. dynamic
      // require with variables, require.resolve, conditional require). For the
      // deploy suite this covers the common next.config.js patterns.
      c = c.replace(
        /\brequire\s*\(\s*(["'"'"'][^"'"'"']+["'"'"'])\s*\)/g,
        (_, mod) => `(await import(${mod})).default`
      );

      // 4. module.exports = → export default
      c = c.replace(/\bmodule\.exports\s*=\s*/, "export default ");

      // Prepend collected imports
      if (imports.length > 0) {
        c = imports.join("\n") + "\n" + c;
      }

      // Clean up empty lines from removed const declarations
      c = c.replace(/\n{3,}/g, "\n\n");

      fs.writeFileSync(f, c);
      console.log("Converted " + f + " from CJS to ESM");
    ' "${config_file}" >> "${BUILD_LOG}" 2>&1
  fi
done

run_pnpm exec vinext build --prerender-all >> "${BUILD_LOG}" 2>&1

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

run_pnpm exec vinext start --port "${PORT}" --hostname 127.0.0.1 >> "${SERVER_LOG}" 2>&1 &
SERVER_PID="$!"
echo "${SERVER_PID}" > "${PID_FILE}"

if ! wait_for_http "${DEPLOYMENT_URL}" 120; then
  echo "Timed out waiting for vinext server at ${DEPLOYMENT_URL}" >&2
  exit 1
fi

DEPLOYMENT_READY=1
echo "${DEPLOYMENT_URL}"
