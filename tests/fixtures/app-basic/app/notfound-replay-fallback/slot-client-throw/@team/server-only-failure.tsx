"use client";

// Fails only while the server renders the document; the browser renders it.
export function ServerOnlyFailure() {
  if (typeof window === "undefined") {
    throw new Error("Replay fallback team not-found failed on the server");
  }
  return <p id="replay-fallback-slot-client-throw-nf">Team not found</p>;
}
