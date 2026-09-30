"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ping } from "./actions";
import { VERSION } from "./version";

export function ActionControls({ bound }: { bound: () => Promise<string> }) {
  const router = useRouter();
  const [result, setResult] = useState("idle");

  function run(action: () => Promise<string>) {
    action().then(setResult, (error: unknown) => setResult(`error: ${String(error)}`));
  }

  return (
    <section data-version={VERSION}>
      <button id="run-action" onClick={() => run(ping)} type="button">
        Run module action
      </button>
      <button id="run-bound" onClick={() => run(bound)} type="button">
        Run bound action
      </button>
      <button id="refresh" onClick={() => router.refresh()} type="button">
        Refresh
      </button>
      <p id="action-result">{result}</p>
    </section>
  );
}
