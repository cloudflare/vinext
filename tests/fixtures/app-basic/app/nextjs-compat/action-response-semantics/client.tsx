"use client";

import { useTransition } from "react";
import { completeAction, missingAction, redirectToAbout } from "./actions";

export default function ActionResponseSemanticsClient() {
  const [, startTransition] = useTransition();

  return (
    <main>
      <h1>Action Response Semantics</h1>
      <button
        id="complete-action"
        type="button"
        onClick={() => {
          startTransition(() => completeAction());
        }}
      >
        Complete
      </button>
      <button
        id="redirect-action"
        type="button"
        onClick={() => {
          startTransition(() => {
            void redirectToAbout();
          });
        }}
      >
        Redirect
      </button>
      <button
        id="missing-action"
        type="button"
        onClick={() => {
          startTransition(() => {
            return missingAction();
          });
        }}
      >
        Missing
      </button>
    </main>
  );
}
