"use client";

export function ServerThrower() {
  if (typeof window === "undefined") {
    throw new Error("Expected error to opt out of server rendering");
  }
  return <p data-testid="shell-error-client">client</p>;
}
