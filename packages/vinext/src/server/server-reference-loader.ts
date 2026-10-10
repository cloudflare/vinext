/**
 * Keep server-reference module evaluation out of the request that first
 * names the module.
 *
 * React resolves every server reference it decodes through
 * `@vitejs/plugin-rsc`'s `globalThis.__vite_rsc_server_require__`, which
 * imports the referenced module on first use. Some references are resolved
 * only once the action consumes them — promise and async-iterable arguments,
 * and the encrypted closure captures an inline action decrypts in its own
 * body — so they load inside the caller's request, past the loads the action
 * dispatcher already runs outside it. A dynamic `import()` carries
 * AsyncLocalStorage into the module's top-level evaluation, so module-scope
 * `cookies()`/`headers()` would capture that caller's request for every later
 * caller in the isolate. Next.js evaluates action modules outside the request
 * store, where those calls throw.
 */
import { runOutsideRequestScopes } from "vinext/shims/internal/als-registry";

const ISOLATED = Symbol.for("vinext.serverReferenceRequire.isolated");

type ServerReferenceRequire = (id: string) => unknown;

/** Wrap plugin-rsc's server-reference loader once; must run after it is installed. */
export function isolateServerReferenceLoads(): void {
  const load: ServerReferenceRequire | undefined = globalThis.__vite_rsc_server_require__;
  if (typeof load !== "function" || ISOLATED in load) return;
  const isolated: ServerReferenceRequire = (id) => runOutsideRequestScopes(() => load(id));
  Object.defineProperty(isolated, ISOLATED, { value: true });
  globalThis.__vite_rsc_server_require__ = isolated;
}
