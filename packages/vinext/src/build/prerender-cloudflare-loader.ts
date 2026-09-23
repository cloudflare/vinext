import { register } from "node:module";

let registered = false;

/** Allow Node's prerender runner to import the Worker bundle without granting Worker bindings. */
export function registerPrerenderCloudflareLoader(): void {
  if (registered) return;
  registered = true;
  const stub = `
    export const tracing = undefined;
    function unavailable() {
      throw new Error("Cloudflare bindings are unavailable during build-time prerendering. Use deployment pre-warming for binding-dependent routes.");
    }
    export const env = new Proxy({}, {
      get: unavailable,
      has: unavailable,
      ownKeys: unavailable,
      getOwnPropertyDescriptor: unavailable,
    });
    export function waitUntil() {
      throw new Error("Cloudflare waitUntil is unavailable during build-time prerendering.");
    }
  `;
  register(
    `data:text/javascript,${encodeURIComponent(`
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === "cloudflare:workers") {
          return { shortCircuit: true, url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(stub)}`)} };
        }
        return nextResolve(specifier, context);
      }
    `)}`,
  );
}
