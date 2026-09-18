"use client";

// Reproduces a React 19 attribute-only hydration mismatch. The module is
// evaluated in both the SSR and browser environments; `isClient` is therefore
// false during server render and true during hydration, so aria-label differs.
// React logs this via console.error ("...won't be patched up") WITHOUT calling
// onRecoverableError, and leaves the server attribute in the DOM.
const isClient = typeof window !== "undefined";

export function HydrationAttributeMismatch() {
  return (
    <button
      data-testid="hydration-attribute-target"
      aria-label={isClient ? "light" : "auto"}
      aria-live="polite"
    >
      Theme
    </button>
  );
}
