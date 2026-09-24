/**
 * Stubs for workerd-native `cloudflare:*` modules inside the Node prerender harness.
 *
 * `vinext build --prerender-all` (and `vinext-cloudflare deploy --prerender-all`)
 * renders routes by starting a Node production server against the *deployed*
 * bundle. For a Cloudflare target that bundle is the Worker entry, which keeps
 * `cloudflare:*` imports external because only workerd can resolve them — a built
 * `dist/server/index.js` still contains `import { env } from "cloudflare:workers"`.
 * Node's ESM loader rejects that scheme with ERR_UNSUPPORTED_ESM_URL_SCHEME, so the
 * prerun died before rendering a single route, even for apps whose prerendered
 * routes never touch a binding. Refs cloudflare/vinext#3319.
 *
 * These hooks are registered only for prerender-purpose servers (see
 * `startProdServer`) and only in the Node process running the prerun: the deployed
 * bundle keeps importing the real modules, because workerd resolves `cloudflare:*`
 * natively. Every `cloudflare:*` specifier resolves to one inert stub module, so
 * the graph can be imported; reading a binding from that stub throws a message
 * naming the cause, which the prerender phase reports per route.
 *
 * `module.register()` is used rather than the synchronous `module.registerHooks()`
 * because the hooks run on Node's loader thread and are available on every
 * supported Node version (registerHooks needs >= 22.15). The loader module is
 * passed as a data: URL since the loader thread cannot see this module's scope.
 */
import { register } from "node:module";

/** Scheme of the workerd-native modules that cannot be resolved by Node. */
const WORKERD_SCHEME = "cloudflare:";
/** Synthetic scheme for the stub URLs our `resolve` hook hands to `load`. */
const STUB_URL_SCHEME = "vinext-workerd-stub:";

/**
 * Source of the module every `cloudflare:*` specifier resolves to during prerender.
 *
 * Rendering HTML needs none of the Workers runtime APIs, so the surface is inert:
 * classes are subclassable-but-empty, the `with*` scoped helpers just run their
 * callback, and `waitUntil` is dropped (there is no request context to extend).
 * `env`, `exports`, `cache`, and `tracing` throw on access: a route that reads a
 * binding cannot be prerendered in Node, and failing with the cause beats both a
 * mystery `undefined` and silently publishing a binding-less page as static.
 */
export const PRERENDER_WORKERD_STUB_SOURCE = `
const HELP =
  "Bindings, named entrypoints, caches, and tracing only exist inside the Workers runtime " +
  "and are unavailable while prerendering in Node. Prerendered routes must not read them: " +
  "keep binding reads in dynamic routes, or discover paths against the deployed Worker with " +
  "\\\`vinext-cloudflare deploy --experimental-warm-cdn-cache\\\`.";

function unavailable(name) {
  throw new Error("[vinext] cloudflare:workers " + name + " is unavailable while prerendering. " + HELP);
}

// Probe keys are answered with undefined rather than throwing so that the stub
// stays inert in unrelated code: \`await env\`, JSON.stringify(), console.log(),
// and RSC serialization all reach for these before they would read a binding.
const PROBE_KEYS = {
  __proto__: null,
  then: true,
  toJSON: true,
  toString: true,
  valueOf: true,
  constructor: true,
  hasOwnProperty: true,
  inspect: true,
};

function unavailableNamespace(name) {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property === "symbol" || PROBE_KEYS[property] === true) return undefined;
        unavailable(name + "." + property);
      },
    },
  );
}

export const env = unavailableNamespace("env");
export const exports = unavailableNamespace("exports");
export const cache = unavailableNamespace("cache");
export const tracing = unavailableNamespace("tracing");

export function waitUntil() {}
export function withEnv(_env, fn) {
  return fn();
}
export function withExports(_exports, fn) {
  return fn();
}
export function withEnvAndExports(_env, _exports, fn) {
  return fn();
}
export class RpcTarget {}
export class RpcStub {
  constructor(value) {
    this.value = value;
  }
}
export class WorkerEntrypoint {}
export class DurableObject {}
export class WorkflowStep {}
export class WorkflowEntrypoint {}
`;

/**
 * Source of the loader-thread module that implements the hooks. Exported so the
 * unit test can import it and drive `resolve`/`load` directly.
 */
export const PRERENDER_WORKERD_LOADER_SOURCE = `
const WORKERD_SCHEME = ${JSON.stringify(WORKERD_SCHEME)};
const STUB_URL_SCHEME = ${JSON.stringify(STUB_URL_SCHEME)};
const STUB_SOURCE = ${JSON.stringify(PRERENDER_WORKERD_STUB_SOURCE)};

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(WORKERD_SCHEME)) {
    return {
      url: STUB_URL_SCHEME + specifier.slice(WORKERD_SCHEME.length),
      format: "module",
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith(WORKERD_SCHEME) || url.startsWith(STUB_URL_SCHEME)) {
    return { format: "module", source: STUB_SOURCE, shortCircuit: true };
  }
  return nextLoad(url, context);
}
`;

let registered = false;

/**
 * Install the `cloudflare:*` stubs for the lifetime of this process. Idempotent:
 * hook registration is process-global and cannot be undone, so repeated prerender
 * servers (and forked render workers, which each register for themselves) are fine.
 *
 * `register()` is synchronous: later dynamic imports block on the loader thread,
 * so anything imported after this call already sees the hooks.
 */
export function registerPrerenderWorkerdStubs(): void {
  if (registered) return;
  registered = true;
  const base64 = Buffer.from(PRERENDER_WORKERD_LOADER_SOURCE).toString("base64");
  register(`data:text/javascript;base64,${base64}`, import.meta.url);
}
