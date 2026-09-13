"use client";

import { useState } from "react";
import { getMode } from "./actions";

export function UseCacheHmrClient() {
  const [mode, setMode] = useState("");

  return (
    <div>
      <button id="call-use-cache-hmr" onClick={() => void getMode().then(setMode)}>
        Read mode
      </button>
      <output data-testid="use-cache-hmr-result">{mode}</output>
    </div>
  );
}
