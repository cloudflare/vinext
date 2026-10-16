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
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { shareIsolatePromise } from "./isolate-shared-promise.js";

const ISOLATED = Symbol.for("vinext.serverReferenceRequire.isolated");

type ServerReferenceRequire = (id: string) => unknown;

/** Wrap plugin-rsc's server-reference loader once; must run after it is installed. */
export function isolateServerReferenceLoads(): void {
  const load: ServerReferenceRequire | undefined = globalThis.__vite_rsc_server_require__;
  if (typeof load !== "function" || ISOLATED in load) return;
  // plugin-rsc memoizes each load for the isolate and returns the same promise
  // to every later caller, so only its first caller started it.
  const started = new WeakSet<Promise<unknown>>();
  const isolated: ServerReferenceRequire = (id) => {
    // Resolve the requesting request before leaving its scopes so the request
    // that starts a load stays alive until the shared load settles.
    //
    // A caller that has already left the request scopes (React's action
    // decoding, inside `loadOutsideRequestScopes()`) has no context here, so
    // nothing is registered for the load it starts. Its I/O still belongs to
    // that caller's request, which only the caller can keep alive; a later
    // request joining the load cannot. Any such caller must keep its own
    // request alive until the loads it starts settle, as
    // `loadOutsideRequestScopes()` does.
    const ctx = getRequestExecutionContext();
    const loaded = runOutsideRequestScopes(() => load(id));
    if (!(loaded instanceof Promise) || started.has(loaded)) return loaded;
    started.add(loaded);
    return shareIsolatePromise(loaded, ctx);
  };
  Object.defineProperty(isolated, ISOLATED, { value: true });
  globalThis.__vite_rsc_server_require__ = isolated;
}
