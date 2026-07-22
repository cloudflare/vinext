import { BrokenClient } from "./broken-client";

// This route throws unconditionally on render and has no error.tsx, so the
// dev recovery boundary inside BrowserRoot is the only thing between the
// thrown error and a torn-down tree. Used by the dev-error-overlay spec to
// verify a soft-nav to a broken target still moves the URL there.
export default function DevOverlayBrokenPage() {
  return (
    <main>
      <BrokenClient />
    </main>
  );
}
