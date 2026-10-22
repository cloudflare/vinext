"use client";

(globalThis as { __vinextSharedClientEvaluated?: boolean }).__vinextSharedClientEvaluated = true;

export function SharedNote() {
  return <p data-testid="shared-note">shared</p>;
}
