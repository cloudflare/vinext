"use client";

import { useState, useTransition } from "react";
import { roundTripAction } from "./actions";

export function ActionButton() {
  const [result, setResult] = useState("idle");
  const [isPending, startTransition] = useTransition();

  return (
    <div>
      <button
        data-testid="override-action"
        disabled={isPending}
        onClick={() => {
          startTransition(async () => {
            setResult(await roundTripAction("override-runtime"));
          });
        }}
      >
        Run action
      </button>
      <output data-testid="override-action-result">{result}</output>
    </div>
  );
}
