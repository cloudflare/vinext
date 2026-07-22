import Link from "next/link";

import { DevOverlayTriggers } from "./dev-overlay-triggers";

// Intentionally has no error.tsx so uncaught render errors propagate up to
// the dev recovery boundary inside BrowserRoot.
export default function DevOverlayTestPage() {
  return (
    <main>
      <h1>Dev Overlay Test</h1>
      <p data-testid="dev-overlay-content">Use the buttons to trigger different error sources.</p>
      <DevOverlayTriggers />
      <p>
        <Link href="/dev-overlay-broken" data-testid="link-to-broken">
          Go to broken page
        </Link>
      </p>
    </main>
  );
}
