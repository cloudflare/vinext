import { ThrowOnClick } from "./throw-on-click";

// The shared global-error.tsx throws `undefined` for this pathname, so the
// falsy value reaches the implicit root error boundary. Used by
// dev-error-overlay.spec.ts.
export default function DevOverlayGlobalErrorThrowUndefinedPage() {
  return (
    <main>
      <h1>Global Error Throw Undefined</h1>
      <ThrowOnClick />
    </main>
  );
}
