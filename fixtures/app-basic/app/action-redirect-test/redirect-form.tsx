"use client";

import { useTransition } from "react";
import { redirectAction } from "../actions/actions";

export default function RedirectForm() {
  const [isPending, startTransition] = useTransition();

  return (
    <div>
      <form
        action={() => {
          startTransition(async () => {
            await redirectAction();
          });
        }}
      >
        <button type="submit" data-testid="redirect-btn" disabled={isPending}>
          {isPending ? "Redirecting..." : "Redirect to About"}
        </button>
      </form>
    </div>
  );
}
