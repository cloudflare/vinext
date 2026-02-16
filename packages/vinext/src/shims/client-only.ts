/**
 * Shim for the `client-only` package.
 *
 * The real `client-only` npm package uses the `react-server` export
 * condition: it's a no-op in client bundles, and throws when imported
 * in a server (RSC) environment.
 *
 * In Vite with @vitejs/plugin-rsc, the environment system already
 * separates server and client module graphs. If the real package is
 * installed it works automatically. This shim exists as a fallback so
 * users don't need to install `client-only` as a separate dependency.
 *
 * Build-time enforcement (preventing client code from being imported
 * in server components) is handled by the RSC plugin's environment
 * system and "use client" / "use server" directives, not by this module.
 */

// Intentionally empty — this is a marker import, not a runtime API.
export {};
