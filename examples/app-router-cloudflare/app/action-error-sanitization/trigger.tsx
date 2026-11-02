"use client";

import { useState } from "react";
import { throwErrorAction, throwStructuredAction } from "./actions";

type CaughtError = { text: string; digest: string; keys: string };

function describe(error: unknown): CaughtError {
  const value = error as { message?: unknown; digest?: unknown } | null;
  return {
    text: error instanceof Error ? `Error: ${error.message}` : JSON.stringify(error),
    digest: typeof value?.digest === "string" ? value.digest : "",
    keys: error && typeof error === "object" ? Object.keys(error).sort().join(",") : "",
  };
}

export function ActionErrorTrigger() {
  const [caught, setCaught] = useState<CaughtError | null>(null);

  async function run(action: () => Promise<void>) {
    setCaught(null);
    try {
      await action();
    } catch (error) {
      setCaught(describe(error));
    }
  }

  return (
    <div>
      <button id="throw-structured" onClick={() => run(throwStructuredAction)}>
        Throw structured
      </button>
      <button id="throw-error" onClick={() => run(throwErrorAction)}>
        Throw error
      </button>
      {caught ? (
        <div id="caught">
          <p id="error-text">{caught.text}</p>
          <p id="error-digest">{caught.digest}</p>
          <p id="error-keys">{caught.keys}</p>
        </div>
      ) : null}
    </div>
  );
}
