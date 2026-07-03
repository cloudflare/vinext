"use client";

import { useState } from "react";
import { touchAction } from "./actions";

declare global {
  interface Window {
    __VINEXT_REVALIDATE_REMOUNT_STARTED__?: boolean;
  }
}

export function Counter() {
  const [count, setCount] = useState(0);

  function runAction() {
    // Arm the loading.tsx sentinel: the fixture's Loading component only logs
    // "Revalidate remount loading mounted" once this flag is set, so mounts
    // during initial navigation/hydration are ignored and only a fallback
    // mounted by the action's revalidation is reported.
    window.__VINEXT_REVALIDATE_REMOUNT_STARTED__ = true;
    touchAction();
  }

  return (
    <>
      <p id="count">{count}</p>
      <button id="increment" type="button" onClick={() => setCount((value) => value + 1)}>
        increment
      </button>
      <button id="run-action" type="button" onClick={runAction}>
        run action
      </button>
    </>
  );
}
