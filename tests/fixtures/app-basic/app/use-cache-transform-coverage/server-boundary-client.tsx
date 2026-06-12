"use client";

import { useState } from "react";
import { fromServerBoundary } from "./server-boundary";

export function ServerBoundaryClientCaller() {
  const [value, setValue] = useState("");

  return (
    <div>
      <button
        id="call-cached-server-boundary"
        onClick={() => void fromServerBoundary().then(setValue)}
      >
        Call server boundary
      </button>
      <output data-testid="cached-server-boundary-result">{value}</output>
    </div>
  );
}
