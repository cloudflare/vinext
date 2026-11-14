import type { Plugin } from "vite";

/**
 * Holds server-environment transforms in Nitro dev until Vite starts listening.
 *
 * Nitro's dev worker imports the rsc and ssr entries as soon as it boots,
 * before any request. Those environments pre-bundle React with Vite's explicit
 * dependency optimizer, which Vite finishes before the HTTP server listens but
 * gives modules nothing to wait on. When the worker wins that race, the entry's
 * imports resolve against empty optimizer metadata and load a second copy of
 * React next to the pre-bundled renderer ("Invalid hook call"). Vite caches
 * those transforms, so every later request fails the same way.
 *
 * Nothing may await a server-environment transform before `listen()`, or
 * startup waits forever. Middleware mode has no `httpServer`, so it is never
 * gated, and a server that never listens never receives a request either.
 */
export function createNitroDevDepsOptimizerGatePlugin(isNitro: () => boolean): Plugin {
  let listening: Promise<void> | undefined;

  return {
    name: "vinext:nitro-dev-deps-optimizer-gate",
    apply: "serve",
    enforce: "pre",
    applyToEnvironment(environment) {
      return isNitro() && environment.config.consumer === "server";
    },
    configureServer(server) {
      const httpServer = server.httpServer;
      if (!isNitro() || !httpServer || httpServer.listening) return;
      listening = new Promise<void>((resolve) => {
        httpServer.once("listening", () => {
          listening = undefined;
          resolve();
        });
      });
    },
    transform() {
      // Every transform, including import analysis, runs after this pre hook.
      return listening?.then(() => null);
    },
  };
}
