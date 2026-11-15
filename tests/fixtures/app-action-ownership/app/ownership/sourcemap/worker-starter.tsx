"use client";

import { useEffect, useState } from "react";

export function WorkerStarter() {
  const [message, setMessage] = useState("");
  useEffect(() => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event) => setMessage(String(event.data));
    return () => worker.terminate();
  }, []);
  return <output data-testid="worker">{message}</output>;
}
