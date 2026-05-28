import Link from "next/link";
import { useState } from "react";

/**
 * Mirrors the Next.js fixture at
 * .nextjs-ref/test/e2e/link-on-navigate-prop/shared/OnNavigate.tsx
 * so we can exercise the same Link `onNavigate` parity scenarios under
 * Pages Router locally. Kept as a regular Pages Router page (rather than
 * the upstream pages/_app.tsx wrapper) so it doesn't interfere with the
 * rest of the pages-basic fixture's apps.
 *
 * Ported from Next.js: test/e2e/link-on-navigate-prop/shared/OnNavigate.tsx
 * https://github.com/vercel/next.js/blob/canary/test/e2e/link-on-navigate-prop/shared/OnNavigate.tsx
 */
export default function OnNavigateFixture() {
  const [isClicked, setIsClicked] = useState(false);
  const [isNavigated, setIsNavigated] = useState(false);
  const [isLocked, setIsLocked] = useState(false);

  const rootPath = "/on-navigate-fixture";

  return (
    <div>
      <nav>
        <div id="navigation-state">
          <p id="is-clicked">isClicked: {isClicked ? "true" : "false"}</p>
          <p id="is-navigated">isNavigated: {isNavigated ? "true" : "false"}</p>
          <p id="is-locked">isLocked: {isLocked ? "true" : "false"}</p>
        </div>
        <button
          id="toggle-lock"
          type="button"
          onClick={() => {
            setIsLocked((v) => !v);
          }}
        >
          {isLocked ? "Unlock" : "Lock"}
        </button>

        <div>
          <Link
            href={rootPath}
            id="link-to-main"
            onClick={() => setIsClicked(true)}
            onNavigate={(e) => {
              if (isLocked) {
                e.preventDefault();
              } else {
                setIsNavigated(true);
              }
            }}
          >
            Client Side Navigation to Main Page
          </Link>
        </div>

        <div>
          <Link
            href={`${rootPath}/subpage`}
            id="link-to-subpage"
            onClick={() => setIsClicked(true)}
            onNavigate={(e) => {
              if (isLocked) {
                e.preventDefault();
              } else {
                setIsNavigated(true);
              }
            }}
          >
            Client Side Navigation to Subpage
          </Link>
        </div>

        <div>
          <Link
            href="https://example.org"
            id="external-link-with-target"
            onClick={() => setIsClicked(true)}
            onNavigate={() => setIsNavigated(true)}
            target="_blank"
          >
            External Link with Target
          </Link>
        </div>

        <div>
          <Link
            download
            href="/zip.zip"
            id="download-link"
            onClick={() => setIsClicked(true)}
            onNavigate={() => {
              setIsNavigated(true);
            }}
          >
            Download Link with download attribute
          </Link>
        </div>
      </nav>
    </div>
  );
}
