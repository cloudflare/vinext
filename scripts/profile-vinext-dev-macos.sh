#!/usr/bin/env bash
set -euo pipefail

export PATH="${HOME}/.cargo/bin:${HOME}/.local/bin:${HOME}/.vite-plus/bin:${PATH}"

# Collect a Samply profile for vinext development performance on macOS.
#
# Usage:
#   ./scripts/profile-vinext-dev-macos.sh
#   ./scripts/profile-vinext-dev-macos.sh --route /dashboard
#   ./scripts/profile-vinext-dev-macos.sh --raw-dev
#   ./scripts/profile-vinext-dev-macos.sh --out-dir /tmp/vinext-profile -- vp exec vinext dev --host 127.0.0.1
#
# Environment:
#   VINEXT_PROFILE_DURATION=60       Raw-dev/custom capture duration in seconds.
#   VINEXT_PROFILE_TIMEOUT=60        Cold-start route readiness timeout in seconds.
#   VINEXT_PROFILE_INTERVAL=2        Process-tree snapshot interval in seconds.
#   VINEXT_PROFILE_RATE=1000         Samply sample rate in Hz, when supported.
#   VINEXT_PROFILE_REQUEST_URL=...   URL to request after the default dev server starts.
#   VINEXT_PROFILE_REQUEST=0         Disable the raw-dev post-start request.
#   VINEXT_PROFILE_ROUTE=/dashboard  Cold-start route to request.
#   VINEXT_PROFILE_EXPECTED_TEXT=... Optional cold-start response text to wait for.
#   VINEXT_PROFILE_CLEAR_CACHE=1     Clear the app's Vite caches before profiling.
#   VINEXT_PROFILE_REQUIRE_ROUTE=1   Exit non-zero if the profile route is not ready.
#   VINEXT_PROFILE_SETUP=0           Skip build + benchmark fixture setup in --benchmark mode.
#   VINEXT_PROFILE_NODE_PERF=0       Disable Node/V8 perf symbol flags.
#   VINEXT_PROFILE_KEEP_JSON=1       Keep the uncompressed samply-profile.json.
#   VINEXT_PROFILE_INSTALL_SAMPLY=1  Install Samply with the official installer if missing.

usage() {
  cat <<'USAGE'
Usage:
  scripts/profile-vinext-dev-macos.sh [options] [-- command ...]

Options:
      --route PATH        Route for the vinext cold-start profile (default: /)
      --benchmark         Profile this repo's generated benchmark fixture instead of the current app
      --clear-cache       Clear the current app's Vite caches before profiling
      --require-route     Fail if the profile route does not return 2xx before timeout
      --raw-dev           Profile an interactive `vinext dev` server for the current app
  -d, --duration SECONDS  Raw-dev/custom capture duration before stopping the command (default: 60)
      --no-duration       Keep recording until the profiled command exits or you press Ctrl-C
  -o, --out-dir DIR       Output root or exact run directory (default: .vinext-profiles)
      --rate HZ           Samply sampling rate, when supported (default: 1000)
      --install-samply    Install Samply with the official installer if it is missing
  -h, --help              Show this help

Default mode:
  Profile the vinext app in the current directory.

The script starts the local vinext dev server on a temporary 127.0.0.1 port,
requests the route, then stops the dev-server process group. Use --clear-cache
for a colder current-app run. Use --benchmark only when running inside the
vinext repository and you intentionally want the generated benchmark fixture.

Artifacts:
  samply-profile.json.gz  Firefox Profiler / Perfetto-compatible profile
  command.log             Samply and command stdout/stderr
  process-tree.log        Periodic process tree snapshots
  metadata.txt            Host, tool, git, and command metadata
USAGE
}

die() {
  echo "error: $*" >&2
  exit 1
}

info() {
  echo ">>> $*"
}

require_macos() {
  local os
  os="$(uname -s)"
  if [[ "${os}" != "Darwin" ]]; then
    die "this script is for macOS; detected ${os}"
  fi
}

install_samply() {
  info "Installing Samply with the official installer"
  curl --proto '=https' --tlsv1.2 -LsSf \
    https://github.com/mstange/samply/releases/latest/download/samply-installer.sh |
    sh
}

absolute_path() {
  local path="$1"
  local directory
  local basename

  if [[ "${path}" == /* ]]; then
    printf '%s\n' "${path}"
    return
  fi

  directory="$(dirname "${path}")"
  basename="$(basename "${path}")"
  if [[ -d "${directory}" ]]; then
    printf '%s/%s\n' "$(cd "${directory}" && pwd -P)" "${basename}"
  else
    printf '%s/%s\n' "$(pwd -P)" "${path#./}"
  fi
}

resolve_executable() {
  local executable="$1"
  local resolved

  if [[ "${executable}" == */* ]]; then
    if [[ ! -x "${executable}" ]]; then
      die "command executable is not runnable: ${executable}"
    fi
    resolved="$(absolute_path "${executable}")"
  else
    resolved="$(type -P "${executable}" || true)"
    if [[ -z "${resolved}" ]]; then
      die "command not found: ${executable}"
    fi
    if [[ ! -x "${resolved}" ]]; then
      die "resolved command is not runnable: ${resolved}"
    fi
  fi

  printf '%s\n' "${resolved}"
}

collect_descendants() {
  local pid="$1"
  local child

  while IFS= read -r child; do
    [[ -n "${child}" ]] || continue
    printf '%s\n' "${child}"
    collect_descendants "${child}"
  done < <(pgrep -P "${pid}" 2>/dev/null || true)
}

snapshot_process_tree() {
  local root_pid="$1"
  local log_file="$2"
  local interval="$3"
  local ids
  local csv

  while kill -0 "${root_pid}" 2>/dev/null; do
    {
      echo "=== $(date -Iseconds) ==="
      ids="$(printf '%s\n' "${root_pid}"; collect_descendants "${root_pid}" | sort -n | uniq)"
      csv="$(printf '%s\n' "${ids}" | paste -sd, -)"
      if [[ -n "${csv}" ]]; then
        ps -ww -o pid=,ppid=,pgid=,stat=,%cpu=,%mem=,etime=,command= -p "${csv}" || true
      fi
      echo
    } >>"${log_file}"
    sleep "${interval}"
  done
}

stop_process_tree() {
  local root_pid="$1"
  local log_file="$2"
  local children
  local child

  children="$(collect_descendants "${root_pid}" | sort -rn | uniq || true)"
  for child in ${children}; do
    kill -TERM "${child}" 2>/dev/null || true
  done
  kill -TERM "${root_pid}" 2>/dev/null || true

  sleep 2

  children="$(collect_descendants "${root_pid}" | sort -rn | uniq || true)"
  for child in ${children}; do
    kill -KILL "${child}" 2>/dev/null || true
  done
  kill -KILL "${root_pid}" 2>/dev/null || true

  {
    echo "=== $(date -Iseconds) cleanup ==="
    echo "Sent TERM/KILL to Samply process tree rooted at ${root_pid}."
    echo
  } >>"${log_file}"
}

stop_profiled_children() {
  local root_pid="$1"
  local log_file="$2"
  local children
  local child

  children="$(collect_descendants "${root_pid}" | sort -rn | uniq || true)"
  if [[ -z "${children}" ]]; then
    return
  fi

  {
    echo "=== $(date -Iseconds) stopping profiled command ==="
    echo "${children}"
    echo
  } >>"${log_file}"

  for child in ${children}; do
    kill -INT "${child}" 2>/dev/null || true
  done

  sleep 3

  children="$(collect_descendants "${root_pid}" | sort -rn | uniq || true)"
  for child in ${children}; do
    kill -TERM "${child}" 2>/dev/null || true
  done
}

request_when_ready() {
  local log_file="$1"
  local url="$2"
  local process_log="$3"
  local timeout_seconds="$4"
  local deadline

  deadline=$((SECONDS + timeout_seconds))
  while ((SECONDS < deadline)); do
    if grep -qE "Local:[[:space:]]+https?://localhost:" "${log_file}" 2>/dev/null; then
      {
        echo "=== $(date -Iseconds) request ==="
        echo "GET ${url}"
      } >>"${process_log}"
      curl -fsS -o /dev/null -w "status=%{http_code} time_total=%{time_total}\n" "${url}" \
        >>"${process_log}" 2>&1 || true
      echo >>"${process_log}"
      return
    fi
    sleep 0.5
  done

  {
    echo "=== $(date -Iseconds) request skipped ==="
    echo "Timed out waiting for dev server URL before requesting ${url}."
    echo
  } >>"${process_log}"
}

clear_directory_contents() {
  local path="$1"
  local log_file="$2"

  if [[ ! -d "${path}" ]]; then
    return
  fi

  {
    echo "=== $(date -Iseconds) clear cache ==="
    echo "${path}"
    echo
  } >>"${log_file}"
  find "${path}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
}

allocate_port() {
  node <<'NODE'
const net = require("node:net");
const server = net.createServer();
server.once("error", (error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address !== "object") {
    console.error("Failed to allocate a benchmark port");
    process.exit(1);
  }
  console.log(address.port);
  server.close((error) => {
    if (error) {
      console.error(error.stack || error.message || String(error));
      process.exit(1);
    }
  });
});
NODE
}

run_setup_command() {
  local log_file="$1"
  local cwd="$2"
  shift 2

  {
    echo "=== $(date -Iseconds) setup ==="
    echo "cwd=${cwd}"
    echo "command=$*"
    echo
  } >>"${log_file}"

  (
    cd "${cwd}"
    "$@"
  ) >>"${log_file}" 2>&1
}

append_node_option() {
  local option="$1"

  case " ${NODE_OPTIONS:-} " in
    *" ${option} "*)
      ;;
    *)
      export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }${option}"
      ;;
  esac
}

set_app_dev_command() {
  local cwd="$1"
  shift
  local dev_args=("$@")
  local repo_root_candidate=""

  if [[ -f "${cwd}/node_modules/vinext/dist/cli.js" ]]; then
    command_args=("node" "${cwd}/node_modules/vinext/dist/cli.js" "dev" "${dev_args[@]}")
    return
  fi

  if [[ -x "${cwd}/node_modules/.bin/vinext" ]]; then
    command_args=("${cwd}/node_modules/.bin/vinext" "dev" "${dev_args[@]}")
    return
  fi

  repo_root_candidate="$(git -C "${cwd}" rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -n "${repo_root_candidate}" && -f "${repo_root_candidate}/packages/vinext/dist/cli.js" ]]; then
    info "node_modules/vinext is missing; using built workspace CLI"
    command_args=("node" "${repo_root_candidate}/packages/vinext/dist/cli.js" "dev" "${dev_args[@]}")
    return
  fi

  command_args=("vp" "exec" "vinext" "dev" "${dev_args[@]}")
}

wait_for_profiled_route() {
  local root_pid="$1"
  local url="$2"
  local expected_text="$3"
  local timeout_seconds="$4"
  local process_log="$5"
  local command_log="$6"
  local response_file="$7"
  local deadline
  local attempts=0
  local status

  deadline=$((SECONDS + timeout_seconds))
  {
    echo "=== $(date -Iseconds) wait for route ==="
    echo "GET ${url}"
    echo "expected_text=${expected_text}"
    echo "timeout_seconds=${timeout_seconds}"
    echo
  } >>"${process_log}"

  while ((SECONDS < deadline)); do
    if ! kill -0 "${root_pid}" 2>/dev/null; then
      {
        echo "=== $(date -Iseconds) route wait failed ==="
        echo "Samply exited before ${url} was served."
        echo
      } >>"${process_log}"
      return 1
    fi

    status="$(
      curl -sS --max-time 2 -o "${response_file}" -w "%{http_code}" "${url}" \
        2>>"${process_log}" || true
    )"
    attempts=$((attempts + 1))

    if [[ "${status}" =~ ^2 ]] &&
      { [[ -z "${expected_text}" ]] || grep -Fq -- "${expected_text}" "${response_file}" 2>/dev/null; }; then
      {
        echo "=== $(date -Iseconds) route ready ==="
        echo "status=${status}"
        echo "attempts=${attempts}"
        echo
      } >>"${process_log}"
      return 0
    fi

    if ((attempts % 40 == 0)); then
      {
        echo "=== $(date -Iseconds) route still starting ==="
        echo "last_status=${status:-curl-failed}"
        echo
      } >>"${process_log}"
    fi
    sleep 0.1
  done

  {
    echo "=== $(date -Iseconds) route timeout ==="
    if [[ -n "${expected_text}" ]]; then
      echo "Timed out waiting for ${url} to return a 2xx response containing ${expected_text}."
    else
      echo "Timed out waiting for ${url} to return a 2xx response."
    fi
    echo
    echo "--- command.log tail ---"
    tail -120 "${command_log}" 2>/dev/null || true
    echo
  } >>"${process_log}"
  return 1
}

write_metadata() {
  local metadata_file="$1"
  local output_dir="$2"
  shift 2
  local command=("$@")

  {
    echo "created_at=$(date -Iseconds)"
    echo "cwd=$(pwd -P)"
    echo "output_dir=${output_dir}"
    echo "command=${command[*]}"
    echo
    echo "uname:"
    uname -a
    echo
    echo "sw_vers:"
    sw_vers 2>/dev/null || true
    echo
    echo "hardware:"
    system_profiler SPHardwareDataType 2>/dev/null | sed -n '1,40p' || true
    echo
    echo "git:"
    git rev-parse --show-toplevel 2>/dev/null || true
    git rev-parse HEAD 2>/dev/null || true
    git status --short 2>/dev/null || true
    echo
    echo "tools:"
    type -P samply || true
    samply --version 2>/dev/null || true
    type -P vp || true
    vp --version 2>/dev/null || true
    command -v node || true
    node --version 2>/dev/null || true
    command -v pnpm || true
    pnpm --version 2>/dev/null || true
  } >"${metadata_file}"
}

main() {
  require_macos

  local duration="${VINEXT_PROFILE_DURATION:-60}"
  local timeout="${VINEXT_PROFILE_TIMEOUT:-60}"
  local snapshot_interval="${VINEXT_PROFILE_INTERVAL:-2}"
  local rate="${VINEXT_PROFILE_RATE:-1000}"
  local out_root=".vinext-profiles"
  local install_missing="${VINEXT_PROFILE_INSTALL_SAMPLY:-0}"
  local request_after_start="${VINEXT_PROFILE_REQUEST:-1}"
  local request_url="${VINEXT_PROFILE_REQUEST_URL:-http://localhost:3000/}"
  local route="${VINEXT_PROFILE_ROUTE:-/}"
  local expected_text="${VINEXT_PROFILE_EXPECTED_TEXT:-}"
  local clear_cache="${VINEXT_PROFILE_CLEAR_CACHE:-0}"
  local require_route="${VINEXT_PROFILE_REQUIRE_ROUTE:-0}"
  local setup_benchmark="${VINEXT_PROFILE_SETUP:-1}"
  local node_perf="${VINEXT_PROFILE_NODE_PERF:-1}"
  local profile_mode="app-cold-start"
  local command_args=()
  local command_cwd
  command_cwd="$(pwd -P)"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --route)
        [[ -n "${2:-}" ]] || die "$1 requires a value"
        route="$2"
        shift 2
        ;;
      --raw-dev)
        profile_mode="raw-dev"
        shift
        ;;
      --benchmark)
        profile_mode="benchmark-cold-start"
        shift
        ;;
      --clear-cache)
        clear_cache="1"
        shift
        ;;
      --require-route)
        require_route="1"
        shift
        ;;
      -d | --duration)
        [[ -n "${2:-}" ]] || die "$1 requires a value"
        duration="$2"
        shift 2
        ;;
      --no-duration)
        duration=""
        shift
        ;;
      -o | --out-dir)
        [[ -n "${2:-}" ]] || die "$1 requires a value"
        out_root="$2"
        shift 2
        ;;
      --rate)
        [[ -n "${2:-}" ]] || die "$1 requires a value"
        rate="$2"
        shift 2
        ;;
      --install-samply)
        install_missing="1"
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      --)
        shift
        [[ $# -gt 0 ]] || die "-- must be followed by a command"
        command_args=("$@")
        profile_mode="custom"
        break
        ;;
      *)
        die "unknown option: $1"
        ;;
    esac
  done

  if [[ -n "${duration}" ]]; then
    if ! [[ "${duration}" =~ ^[0-9]+$ ]] || [[ "${duration}" -lt 1 ]]; then
      die "--duration must be a positive integer"
    fi
  fi
  if ! [[ "${timeout}" =~ ^[0-9]+$ ]] || [[ "${timeout}" -lt 1 ]]; then
    die "VINEXT_PROFILE_TIMEOUT must be a positive integer"
  fi
  if ! [[ "${snapshot_interval}" =~ ^[0-9]+$ ]] || [[ "${snapshot_interval}" -lt 1 ]]; then
    die "VINEXT_PROFILE_INTERVAL must be a positive integer"
  fi
  if ! [[ "${rate}" =~ ^[0-9]+$ ]] || [[ "${rate}" -lt 1 ]]; then
    die "--rate must be a positive integer"
  fi

  if ! type -P samply >/dev/null 2>&1; then
    if [[ "${install_missing}" = "1" ]]; then
      install_samply
    else
      cat >&2 <<'EOF'
error: samply is not installed.

Install it first:
  curl --proto '=https' --tlsv1.2 -LsSf https://github.com/mstange/samply/releases/latest/download/samply-installer.sh | sh
  samply setup

Or rerun this script with --install-samply to run the installer automatically.
EOF
      exit 1
    fi
  fi

  if ! type -P samply >/dev/null 2>&1; then
    die "samply is still not on PATH after install"
  fi

  local samply_bin
  samply_bin="$(resolve_executable "samply")"

  local timestamp
  timestamp="$(date +%Y%m%d-%H%M%S)"
  local output_dir
  if [[ "${out_root}" == */vinext-dev-profile-* ]]; then
    output_dir="$(absolute_path "${out_root}")"
  else
    output_dir="$(absolute_path "${out_root}")/vinext-dev-profile-${timestamp}"
  fi
  mkdir -p "${output_dir}"

  local raw_profile="${output_dir}/samply-profile.json"
  local gz_profile="${output_dir}/samply-profile.json.gz"
  local command_log="${output_dir}/command.log"
  local process_log="${output_dir}/process-tree.log"
  local metadata_file="${output_dir}/metadata.txt"
  local help_file="${output_dir}/samply-record-help.txt"
  local setup_log="${output_dir}/setup.log"
  local route_response_file="${output_dir}/route-response.html"
  local profile_name="vinext dev"
  local request_target=""
  local repo_root=""
  local port=""

  if [[ "${profile_mode}" = "app-cold-start" ]]; then
    if [[ "${route}" != /* ]]; then
      die "--route must start with /"
    fi

    port="$(allocate_port)"
    command_cwd="$(pwd -P)"
    set_app_dev_command "${command_cwd}" "--host" "127.0.0.1" "--port" "${port}"
    request_target="http://127.0.0.1:${port}${route}"
    profile_name="vinext app cold start ${route}"

    if [[ "${clear_cache}" != "0" ]]; then
      clear_directory_contents "${command_cwd}/node_modules/.vite" "${process_log}"
      clear_directory_contents "${command_cwd}/.vite" "${process_log}"
    else
      {
        echo "=== $(date -Iseconds) cache clear skipped ==="
        echo "VINEXT_PROFILE_CLEAR_CACHE=0"
        echo
      } >>"${process_log}"
      info "Skipping app cache clear because VINEXT_PROFILE_CLEAR_CACHE=0"
    fi
  elif [[ "${profile_mode}" = "benchmark-cold-start" ]]; then
    if [[ "${route}" != /* ]]; then
      die "--route must start with /"
    fi

    repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    [[ -n "${repo_root}" ]] || die "could not find the vinext repository root"
    [[ -d "${repo_root}/benchmarks/perf" ]] || die "missing benchmarks/perf under ${repo_root}"
    [[ -d "${repo_root}/benchmarks/vinext" ]] || die "missing benchmarks/vinext under ${repo_root}"
    if [[ -z "${expected_text}" ]]; then
      expected_text="Benchmark App"
    fi

    if [[ "${setup_benchmark}" != "0" ]]; then
      info "Running benchmark setup from ${repo_root}"
      run_setup_command "${setup_log}" "${repo_root}" vp run build
      run_setup_command "${setup_log}" "${repo_root}" node benchmarks/generate-app.mjs
    else
      {
        echo "=== $(date -Iseconds) setup skipped ==="
        echo "VINEXT_PROFILE_SETUP=0"
        echo
      } >>"${setup_log}"
      info "Skipping benchmark setup because VINEXT_PROFILE_SETUP=0"
    fi

    clear_directory_contents "${repo_root}/benchmarks/vinext/node_modules/.vite" "${process_log}"
    clear_directory_contents "${repo_root}/benchmarks/vinext/.vite" "${process_log}"

    port="$(allocate_port)"
    command_cwd="${repo_root}/benchmarks/vinext"
    local vp_path="${command_cwd}/node_modules/vite-plus/bin/vp"
    [[ -f "${vp_path}" ]] || die "missing ${vp_path}; run the repo install before profiling"

    command_args=("node" "${vp_path}" "dev" "--host" "127.0.0.1" "--port" "${port}")
    request_target="http://127.0.0.1:${port}${route}"
    profile_name="vinext benchmark cold start ${route}"
  elif [[ "${profile_mode}" = "raw-dev" ]]; then
    command_cwd="$(pwd -P)"
    set_app_dev_command "${command_cwd}"
    request_target="${request_url}"
    profile_name="vinext dev raw"
  fi

  local executable
  executable="$(resolve_executable "${command_args[0]}")"
  command_args[0]="${executable}"

  local file_description
  file_description="$(file -b "${executable}" 2>/dev/null || true)"
  if [[ "${file_description}" != *"Mach-O"* ]]; then
    cat >&2 <<EOF
warning: ${executable} does not look like a Mach-O executable.
On macOS, Samply may fail to record shell scripts or system apps. Prefer a real executable.
EOF
  fi

  export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"
  export NO_COLOR="${NO_COLOR:-1}"

  mkdir -p "$(dirname "${help_file}")"
  "${samply_bin}" record --help >"${help_file}" 2>&1 || true

  local samply_args=("${samply_bin}" "record" "--save-only" "-o" "${raw_profile}")
  if grep -q -- "--profile-name" "${help_file}"; then
    samply_args+=("--profile-name" "${profile_name}")
  fi
  if grep -q -- "--include-args" "${help_file}"; then
    samply_args+=("--include-args=10")
  fi
  if grep -q -- "--rate" "${help_file}"; then
    samply_args+=("--rate" "${rate}")
  fi
  if grep -q -- "--unlink-aux-files" "${help_file}"; then
    samply_args+=("--unlink-aux-files")
  fi
  samply_args+=("--" "${command_args[@]}")

  write_metadata "${metadata_file}" "${output_dir}" "${command_args[@]}"
  if [[ "${node_perf}" != "0" ]]; then
    append_node_option "--perf-prof"
    append_node_option "--perf-basic-prof"
    append_node_option "--perf-prof-unwinding-info"
    append_node_option "--interpreted-frames-native-stack"
  fi
  {
    echo
    echo "profile_mode=${profile_mode}"
    echo "command_cwd=${command_cwd}"
    echo "timeout_seconds=${timeout}"
    echo "route=${route}"
    echo "expected_text=${expected_text}"
    echo "request_url=${request_target}"
    echo "clear_cache=${clear_cache}"
    echo "require_route=${require_route}"
    echo "setup_benchmark=${setup_benchmark}"
    echo "node_perf=${node_perf}"
    echo "NODE_OPTIONS=${NODE_OPTIONS:-}"
  } >>"${metadata_file}"

  info "Output directory: ${output_dir}"
  info "Mode: ${profile_mode}"
  info "Command cwd: ${command_cwd}"
  info "Command: ${command_args[*]}"
  if [[ "${profile_mode}" = "app-cold-start" || "${profile_mode}" = "benchmark-cold-start" ]]; then
    info "Profile route: ${request_target}"
    info "Capture duration: until the profile route is served"
  elif [[ -n "${duration}" ]]; then
    info "Capture duration: ${duration}s"
  else
    info "Capture duration: until command exit or Ctrl-C"
  fi

  local samply_pid=""
  local monitor_pid=""
  local timer_pid=""
  local request_pid=""
  local cleanup_done="0"
  local expected_stop="0"
  local expected_stop_file="${output_dir}/expected-stop"
  local route_wait_status="0"

  cleanup() {
    if [[ "${cleanup_done}" = "1" ]]; then
      return
    fi
    cleanup_done="1"

    if [[ -n "${timer_pid}" ]]; then
      kill "${timer_pid}" 2>/dev/null || true
      wait "${timer_pid}" 2>/dev/null || true
    fi
    if [[ -n "${monitor_pid}" ]]; then
      kill "${monitor_pid}" 2>/dev/null || true
      wait "${monitor_pid}" 2>/dev/null || true
    fi
    if [[ -n "${request_pid}" ]]; then
      kill "${request_pid}" 2>/dev/null || true
      wait "${request_pid}" 2>/dev/null || true
    fi
    if [[ -n "${samply_pid}" ]] && kill -0 "${samply_pid}" 2>/dev/null; then
      stop_profiled_children "${samply_pid}" "${process_log}"
      sleep 5
      if kill -0 "${samply_pid}" 2>/dev/null; then
        stop_process_tree "${samply_pid}" "${process_log}"
      fi
    fi
  }
  trap cleanup INT TERM EXIT

  local launch_cwd
  launch_cwd="$(pwd -P)"
  cd "${command_cwd}"
  "${samply_args[@]}" > >(tee "${command_log}") 2>&1 &
  samply_pid="$!"
  cd "${launch_cwd}"

  snapshot_process_tree "${samply_pid}" "${process_log}" "${snapshot_interval}" &
  monitor_pid="$!"

  if [[ "${profile_mode}" = "app-cold-start" || "${profile_mode}" = "benchmark-cold-start" ]]; then
    if wait_for_profiled_route \
      "${samply_pid}" \
      "${request_target}" \
      "${expected_text}" \
      "${timeout}" \
      "${process_log}" \
      "${command_log}" \
      "${route_response_file}"; then
      expected_stop="1"
      : >"${expected_stop_file}"
      stop_profiled_children "${samply_pid}" "${process_log}"
    else
      route_wait_status="1"
      expected_stop="1"
      : >"${expected_stop_file}"
      stop_profiled_children "${samply_pid}" "${process_log}"
    fi
  elif [[ "${profile_mode}" = "raw-dev" && "${request_after_start}" != "0" ]]; then
    request_when_ready "${command_log}" "${request_target}" "${process_log}" 45 &
    request_pid="$!"
  fi

  if [[ "${profile_mode}" != "app-cold-start" && "${profile_mode}" != "benchmark-cold-start" && -n "${duration}" ]]; then
    (
      sleep "${duration}"
      if kill -0 "${samply_pid}" 2>/dev/null; then
        echo ">>> $(date -Iseconds) duration elapsed; stopping profiled command" >>"${process_log}"
        : >"${expected_stop_file}"
        stop_profiled_children "${samply_pid}" "${process_log}"
      fi
    ) &
    timer_pid="$!"
  fi

  local status=0
  wait "${samply_pid}" || status="$?"

  cleanup_done="1"
  trap - INT TERM EXIT
  if [[ -n "${timer_pid}" ]]; then
    kill "${timer_pid}" 2>/dev/null || true
    wait "${timer_pid}" 2>/dev/null || true
  fi
  if [[ -n "${monitor_pid}" ]]; then
    kill "${monitor_pid}" 2>/dev/null || true
    wait "${monitor_pid}" 2>/dev/null || true
  fi
  if [[ -n "${request_pid}" ]]; then
    kill "${request_pid}" 2>/dev/null || true
    wait "${request_pid}" 2>/dev/null || true
  fi
  if [[ -f "${expected_stop_file}" ]]; then
    expected_stop="1"
  fi

  if [[ -s "${raw_profile}" ]]; then
    gzip -c "${raw_profile}" >"${gz_profile}"
    if [[ "${VINEXT_PROFILE_KEEP_JSON:-0}" != "1" ]]; then
      rm -f "${raw_profile}"
    fi
  elif [[ -s "${gz_profile}" ]]; then
    :
  else
    echo "Samply did not write ${raw_profile}." >&2
    echo "See ${command_log} for details." >&2
    exit "${status:-1}"
  fi

  (
    cd "${output_dir}"
    shasum -a 256 ./* >SHA256SUMS 2>/dev/null || true
  )

  cat >"${output_dir}/README.txt" <<EOF
Samply profile collected for:
  ${command_args[*]}

Open samply-profile.json.gz in https://profiler.firefox.com/ or https://ui.perfetto.dev/.

Useful files:
  samply-profile.json.gz  Main profile artifact.
  command.log             Profiler and command output.
  process-tree.log        Process tree snapshots to confirm the dev server and child tools were present.
  metadata.txt            Host, tool, git, and command metadata.
  setup.log               Benchmark setup output, when default mode runs setup.
EOF

  info "Profile: ${gz_profile}"
  info "Logs: ${command_log}"
  info "Process tree: ${process_log}"

  if [[ "${route_wait_status}" != "0" ]]; then
    if [[ "${require_route}" = "1" ]]; then
      echo "error: profile route did not become ready; profile is for the failed startup." >&2
      return "${route_wait_status}"
    fi
    echo "warning: profile route did not become ready; profile is for the failed startup." >&2
  fi

  if [[ "${status}" != "0" ]]; then
    if [[ "${expected_stop}" = "1" && -s "${gz_profile}" ]]; then
      echo "warning: samply exited with status ${status} after the expected stop; profile artifact was written" >&2
      return 0
    fi
    if [[ "${status}" = "130" && -s "${gz_profile}" ]]; then
      return 0
    fi
    echo "error: profiled command exited with status ${status}; profile is for the failed startup." >&2
    if grep -q "Command .*vinext.* not found in node_modules/.bin" "${command_log}"; then
      cat >&2 <<'EOF'

The default command is `vp exec vinext dev`, but `vinext` is missing from
node_modules/.bin in the directory where you ran the script.

Fix the local workspace bins, then rerun:
  vp install

If the package was installed before packages/vinext/dist/cli.js existed, rerun
the install after building vinext so the bin symlink is recreated.
EOF
    fi
    return "${status}"
  fi
}

main "$@"
