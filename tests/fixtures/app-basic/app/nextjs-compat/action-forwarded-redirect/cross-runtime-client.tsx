"use client";

import Link from "next/link";
import { delayedCrossRuntimeRedirectAction } from "./actions";

export default function ActionForwardedCrossRuntimeClient() {
  return (
    <main>
      <h1>Action Forwarded Cross Runtime</h1>
      <button
        id="run-cross-runtime-redirect"
        type="button"
        onClick={async () => {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          await delayedCrossRuntimeRedirectAction();
        }}
      >
        Run cross-runtime redirect
      </button>
      <Link id="go-cross-runtime-other" href="/nextjs-compat/action-forwarded-redirect/edge/other">
        Other
      </Link>
    </main>
  );
}
