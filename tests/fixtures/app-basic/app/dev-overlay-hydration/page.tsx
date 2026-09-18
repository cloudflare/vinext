import { HydrationAttributeMismatch } from "./hydration-attribute-mismatch";

export default function DevOverlayHydrationPage() {
  return (
    <main>
      <h1>Dev Overlay Hydration</h1>
      <p data-testid="dev-overlay-hydration-content">attribute-only hydration mismatch</p>
      <HydrationAttributeMismatch />
    </main>
  );
}
