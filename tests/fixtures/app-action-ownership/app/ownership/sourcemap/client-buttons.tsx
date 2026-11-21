"use client";

import { useState, useTransition } from "react";
import { serverModuleAction } from "./actions";
import { cachedModuleFunction } from "./cached";

export function ClientButtons() {
  const [result, setResult] = useState("CLIENT_COMPONENT_SOURCE_MARKER");
  const [pending, startTransition] = useTransition();
  return (
    <>
      <button
        disabled={pending}
        onClick={() => startTransition(async () => setResult(await serverModuleAction()))}
      >
        Call server action
      </button>
      <button
        disabled={pending}
        onClick={() => startTransition(async () => setResult(await cachedModuleFunction()))}
      >
        Call cached function
      </button>
      <output data-testid="result">{result}</output>
    </>
  );
}
