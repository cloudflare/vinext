/**
 * Shared state for instrumentation.ts testing in pages-router-cloudflare.
 *
 * ## Two-mode strategy
 *
 * ### Production (vite build + wrangler dev)
 *
 * instrumentation.ts is bundled directly into the Worker and register() runs
 * as a top-level await at module evaluation time. The API route handler also
 * runs in the same Worker bundle. Both share the same globalThis, so we store
 * state there — no cross-process IPC needed.
 *
 * Detection: inside a Cloudflare Worker, `navigator.userAgent` is
 * "Cloudflare-Workers". The host Node.js process has no `navigator`.
 *
 * ### Dev (vite dev + @cloudflare/vite-plugin)
 *
 * The topology is split across two processes:
 *   - instrumentation.ts runs in the host Node.js process via
 *     runInstrumentation() → createDirectRunner() → ESModulesEvaluator
 *   - API routes run inside the Cloudflare Worker subprocess (Miniflare),
 *     which is a CloudflareDevEnvironment dispatching to a real separate process
 *
 * globalThis is NOT shared across process boundaries, so writes from
 * instrumentation.ts are invisible to the API route and vice versa.
 * Both processes can access the same real filesystem, so a JSON file in /tmp
 * is the correct bridge.
 *
 * This is a test-only concern. Real-world instrumentation.ts files set up
 * observability tools (Sentry, OpenTelemetry, etc.) and never need to expose
 * their internal state to API routes.
 */

import fs from "node:fs";
import path from "node:path";

export interface CapturedRequestError {
  message: string;
  path: string;
  method: string;
  routerKind: string;
  routePath: string;
  routeType: string;
}

interface State {
  registerCalled: boolean;
  errors: CapturedRequestError[];
}

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

/**
 * True when running inside a real Cloudflare Worker bundle (prod or wrangler dev
 * with a built bundle). False in the host Node.js process (vite dev path).
 *
 * navigator.userAgent === "Cloudflare-Workers" is the canonical runtime check.
 * We guard with typeof so this module is safe to import in any context.
 */
function isWorkerRuntime(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.userAgent === "string" &&
    navigator.userAgent === "Cloudflare-Workers"
  );
}

// ---------------------------------------------------------------------------
// globalThis-based storage (Worker runtime)
// ---------------------------------------------------------------------------

const GT_KEY = "__vinext_pages_cf_instr_state__";

function readGlobalState(): State {
  const s = (globalThis as Record<string, unknown>)[GT_KEY] as State | undefined;
  return s ?? { registerCalled: false, errors: [] };
}

function writeGlobalState(state: State): void {
  (globalThis as Record<string, unknown>)[GT_KEY] = state;
}

// ---------------------------------------------------------------------------
// /tmp file-based storage (host Node.js process in dev)
// ---------------------------------------------------------------------------

const STATE_FILE = path.join(
  "/tmp",
  "vinext-pages-router-cloudflare-instr-state.json",
);

function readFileState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as State;
  } catch {
    return { registerCalled: false, errors: [] };
  }
}

function writeFileState(state: State): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state), "utf-8");
}

// ---------------------------------------------------------------------------
// Unified accessors — delegates to the right backend automatically
// ---------------------------------------------------------------------------

function readState(): State {
  return isWorkerRuntime() ? readGlobalState() : readFileState();
}

function writeState(state: State): void {
  if (isWorkerRuntime()) {
    writeGlobalState(state);
  } else {
    writeFileState(state);
  }
}

export function isRegisterCalled(): boolean {
  return readState().registerCalled;
}

export function getCapturedErrors(): CapturedRequestError[] {
  return readState().errors;
}

export function markRegisterCalled(): void {
  const state = readState();
  state.registerCalled = true;
  writeState(state);
}

export function recordRequestError(entry: CapturedRequestError): void {
  const state = readState();
  state.errors.push(entry);
  writeState(state);
}

export function resetInstrumentationState(): void {
  writeState({ registerCalled: false, errors: [] });
}
