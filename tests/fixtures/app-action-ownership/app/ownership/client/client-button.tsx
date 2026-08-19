"use client";
import { useState, useTransition } from "react";
import { clientImportedAction } from "../actions/client";
export function ClientButton() {
  const [result, setResult] = useState("");
  const [pending, startTransition] = useTransition();
  return (
    <>
      <button
        data-testid="client"
        disabled={pending}
        onClick={() => startTransition(async () => setResult(await clientImportedAction()))}
      >
        client
      </button>
      <output data-testid="client-result">{result}</output>
    </>
  );
}
