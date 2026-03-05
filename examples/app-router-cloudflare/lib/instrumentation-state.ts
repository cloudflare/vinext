/**
 * Shared state for instrumentation.ts testing in app-router-cloudflare.
 *
 * ## The Worker boundary problem
 *
 * When @cloudflare/vite-plugin is present, app code (including API routes)
 * runs inside a Cloudflare Worker via miniflare — a separate process with its
 * own isolated globalThis. The host Node.js process runs vinext's configureServer
 * hook and calls runInstrumentation(), which executes register() in the host
 * process. A globalThis flag set there is invisible to the Worker.
 *
 * ## Solution: temp file bridge
 *
 * register() (host process) writes a sentinel file to disk.
 * The API route (Worker process) reads that file to check whether register()
 * was called. The file path uses the project root so both sides agree on it.
 *
 * This is test-only infrastructure — real instrumentation hooks (Sentry,
 * OpenTelemetry, etc.) don't need cross-process visibility.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const STATE_FILE = path.join(os.tmpdir(), "vinext-instrumentation-test-state.json");

interface State {
  registerCalled: boolean;
  errors: CapturedRequestError[];
}

export interface CapturedRequestError {
  message: string;
  path: string;
  method: string;
  routerKind: string;
  routePath: string;
  routeType: string;
}

function readState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as State;
  } catch {
    return { registerCalled: false, errors: [] };
  }
}

function writeState(state: State): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state), "utf-8");
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
