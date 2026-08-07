"use client";

import { useState } from "react";
import { getCachedMessage, getUncachedMessage } from "./actions";

export function ClientCacheCaller() {
  const [message, setMessage] = useState("");
  const [completedCalls, setCompletedCalls] = useState(0);

  function callCachedMessage(value: string) {
    void getCachedMessage(value).then(
      (result) => {
        setMessage(result);
        setCompletedCalls((count) => count + 1);
      },
      (error) => {
        setMessage(`error:${error instanceof Error ? error.message : String(error)}`);
      },
    );
  }

  function callUncachedMessage(value: string) {
    void getUncachedMessage(value).then(
      (result) => {
        setMessage(result);
        setCompletedCalls((count) => count + 1);
      },
      (error) => {
        setMessage(`error:${error instanceof Error ? error.message : String(error)}`);
      },
    );
  }

  return (
    <div>
      <button id="call-client-imported-cache" onClick={() => callCachedMessage("direct")}>
        Call cached function
      </button>
      <button id="call-client-imported-cache-other" onClick={() => callCachedMessage("other")}>
        Call cached function with another argument
      </button>
      <button id="call-client-imported-server" onClick={() => callUncachedMessage("direct")}>
        Call server function
      </button>
      <output data-testid="client-imported-cache-result">{message}</output>
      <output data-testid="client-imported-cache-call-count">{completedCalls}</output>
    </div>
  );
}
