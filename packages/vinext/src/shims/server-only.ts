/**
 * Shim for the `server-only` package.
 *
 * The real `server-only` npm package uses the `react-server` export
 * condition: it's a no-op when resolved with react-server conditions
 * (RSC environment), and throws when imported in a client bundle.
 *
 * In Vite with @vitejs/plugin-rsc, the RSC environment already uses
 * react-server conditions, so if the real package is installed it works
 * automatically. This shim exists as a fallback so users don't need to
 * install `server-only` as a separate dependency — importing it just
 * works.
 *
 * Build-time enforcement (preventing server code from leaking into
 * client bundles) is handled by the RSC plugin's environment system
 * and "use client" / "use server" directives, not by this module.
 */

// Intentionally empty — this is a marker import, not a runtime API.
export {};
