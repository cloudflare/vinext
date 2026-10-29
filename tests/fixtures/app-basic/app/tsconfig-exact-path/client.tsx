"use client";

import { useEffect, useState } from "react";
import { entrySource } from "fake-tsconfig-exact-lib";
import { runtimeSource } from "fake-tsconfig-exact-lib/runtime";

const messageName = "greeting";

export function TsconfigExactPathClient() {
  const [hydrated, setHydrated] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    setHydrated(true);
    // A package template import next to an unrelated exact tsconfig key still
    // goes through the package's wildcard `exports`.
    void import(`fake-tsconfig-exact-lib/messages/${messageName}`).then((module) =>
      setMessage(module.message),
    );
  }, []);
  return (
    <div data-testid="client" data-hydrated={hydrated ? "true" : undefined}>
      <p data-testid="client-entry">{entrySource}</p>
      <p data-testid="client-runtime">{runtimeSource}</p>
      <p data-testid="client-message">{message}</p>
    </div>
  );
}
