"use client";

import { useEffect } from "react";

let clientRenderCount = 0;

export function RenderProbe() {
  if (typeof window !== "undefined") {
    clientRenderCount += 1;
  }

  useEffect(() => {
    const output = document.querySelector("[data-testid=strict-mode-render-count]");
    // Avoid scheduling another React render, which would contaminate the value
    // this fixture is measuring.
    if (output) output.textContent = String(clientRenderCount);
  }, []);

  return <p data-testid="strict-mode-render-count">0</p>;
}
