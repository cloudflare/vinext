"use client";

(globalThis as { __vinextUnrelatedClientEvaluated?: boolean }).__vinextUnrelatedClientEvaluated =
  true;

export function Unrelated() {
  return <p data-testid="unrelated">unrelated</p>;
}
