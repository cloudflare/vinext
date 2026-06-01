"use client";

import { useTransition } from "react";
import { redirectAction } from "../actions/actions";

export default function RedirectForm() {
  const [isPending, startTransition] = useTransition();

  return (
    <div>
      <button
        type="button"
        data-testid="redirect-btn"
        disabled={isPending}
        onClick={() => {
          startTransition(() => {
            void redirectAction();
          });
        }}
      >
        {isPending ? "Redirecting..." : "Redirect to About"}
      </button>
    </div>
  );
}
