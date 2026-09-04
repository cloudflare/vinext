// Reproduces a React 19 attribute-only hydration mismatch in the Pages Router.
// The module is evaluated on the server (isClient false → aria-label "auto")
// and again in the browser during hydration (isClient true → aria-label
// "light"). React logs this via console.error ("...won't be patched up")
// without calling onRecoverableError and leaves the server attribute in place.
const isClient = typeof window !== "undefined";

export default function DevOverlayHydrationPage() {
  return (
    <main>
      <h1>Pages Dev Overlay Hydration</h1>
      <p data-testid="dev-overlay-hydration-content">attribute-only hydration mismatch</p>
      <button
        data-testid="hydration-attribute-target"
        aria-label={isClient ? "light" : "auto"}
        aria-live="polite"
      >
        Theme
      </button>
    </main>
  );
}
