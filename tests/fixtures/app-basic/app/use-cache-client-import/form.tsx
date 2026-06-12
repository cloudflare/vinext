"use client";

import { useState } from "react";
import { getCachedMessage } from "./actions";

export function ClientCacheCaller() {
  const [message, setMessage] = useState("");

  return (
    <div>
      <button
        id="call-client-imported-cache"
        onClick={() =>
          void getCachedMessage("direct").then(setMessage, (error) => {
            setMessage(`error:${error instanceof Error ? error.message : String(error)}`);
          })
        }
      >
        Call cached function
      </button>
      <output data-testid="client-imported-cache-result">{message}</output>
    </div>
  );
}
