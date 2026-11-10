"use client";

export function RootRethrow() {
  // Throws in the HTML render and again in the browser, with a message that
  // differs between them, as an engine-generated message can.
  throw new Error(
    typeof window === "undefined" ? "root rethrow on the server" : "root rethrow in the browser",
  );
}
