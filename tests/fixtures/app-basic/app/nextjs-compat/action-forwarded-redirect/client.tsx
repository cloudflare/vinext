"use client";

import Link from "next/link";
import { delayedRedirectAction } from "./actions";

export default function ActionForwardedRedirectClient() {
  return (
    <main>
      <h1>Action Forwarded Redirect</h1>
      <button
        id="run-forwarded-redirect"
        type="button"
        onClick={async () => {
          await new Promise((resolve) => setTimeout(resolve, 1000));
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
