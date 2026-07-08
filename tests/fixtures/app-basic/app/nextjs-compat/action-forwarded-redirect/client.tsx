"use client";

import Link from "next/link";
import { delayedRedirectAction } from "./actions";

async function waitForPathname(pathname: string): Promise<void> {
  const start = Date.now();
  while (window.location.pathname !== pathname) {
    if (Date.now() - start > 10_000) {
      throw new Error(`Timed out waiting for ${pathname}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export default function ActionForwardedRedirectClient() {
  return (
    <main>
      <h1>Action Forwarded Redirect</h1>
      <button
        id="run-forwarded-redirect"
        type="button"
        onClick={async () => {
          await waitForPathname("/nextjs-compat/action-forwarded-redirect/other");
          await delayedRedirectAction();
        }}
      >
        Run redirect
      </button>
      <Link id="go-forwarded-redirect-other" href="/nextjs-compat/action-forwarded-redirect/other">
        Other
      </Link>
    </main>
  );
}
