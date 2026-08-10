"use client";

import { useState } from "react";

export function SourceState() {
  const [count, setCount] = useState(0);

  return (
    <>
      <div id="interception-mw-source-count">{count}</div>
      <button id="interception-mw-source-increment" onClick={() => setCount((value) => value + 1)}>
        Increment source state
      </button>
    </>
  );
}
