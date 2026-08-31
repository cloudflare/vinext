"use client";

import { useState, useTransition } from "react";

export function ActionButton({ action, id }: { action: () => Promise<string>; id: string }) {
  const [result, setResult] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <div>
      <button
        data-testid={id}
        disabled={pending}
        onClick={() => startTransition(async () => setResult(await action()))}
      >
        {id}
      </button>
      <output data-testid={`${id}-result`}>{result}</output>
    </div>
  );
}
