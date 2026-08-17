"use client";

import { useState } from "react";

export default function WebWorkerPage() {
  const [result, setResult] = useState("(not run)");

  function runWorker() {
    try {
      const worker = new Worker(new URL("../echo.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (event: MessageEvent<string>) => {
        setResult(`worker replied: ${event.data}`);
        worker.terminate();
      };
      worker.onerror = (event) => {
        setResult(`error: ${event.message}`);
        worker.terminate();
      };
      worker.postMessage("ping");
    } catch (error) {
      setResult(`error: ${String(error)}`);
    }
  }

  return (
    <main>
      <button data-testid="start-worker" onClick={runWorker}>
        start worker
      </button>
      <p data-testid="worker-result">{result}</p>
    </main>
  );
}
