"use client";

import { useState } from "react";
import { fromServerBoundary } from "./server-boundary";

export function ServerBoundaryClientCaller() {
  const [value, setValue] = useState("");
  const [completedCalls, setCompletedCalls] = useState(0);

  return (
    <div>
      <button
        id="call-cached-server-boundary"
        onClick={() =>
          void fromServerBoundary().then((nextValue) => {
            setValue(nextValue);
            setCompletedCalls((count) => count + 1);
          })
        }
      >
        Call server boundary
      </button>
      <output data-testid="cached-server-boundary-result">{value}</output>
      <output data-testid="cached-server-boundary-call-count">{completedCalls}</output>
    </div>
  );
}
