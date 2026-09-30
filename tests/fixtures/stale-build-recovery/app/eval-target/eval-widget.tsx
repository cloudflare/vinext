"use client";

// Fails only in the browser, so the server render of the route still succeeds.
if (typeof window !== "undefined") {
  throw new Error("EVAL_WIDGET_EVALUATION_FAILURE");
}

export function EvalWidget() {
  return <p id="widget">EVAL_WIDGET_MARKER</p>;
}
