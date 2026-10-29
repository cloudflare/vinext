"use client";

import { useEffect, useState } from "react";
import { openConnection, recordMount } from "./effect-log";

// Models a component that opens a live connection on mount (a chat stream,
// a subscription) and keeps local state the user has built up.
export function useEffectProbe(name: string): number {
  // The lazy initialiser runs once per mount, so it doubles as a mount counter.
  const [instance] = useState(() => recordMount(name));
  useEffect(() => openConnection(`${name}#${instance}`), [name, instance]);
  return instance;
}

export function EffectProbe({ name }: { name: string }) {
  useEffectProbe(name);
  const [count, setCount] = useState(0);

  return (
    <div data-effect-probe={name}>
      <button data-testid={`increment-${name}`} onClick={() => setCount((value) => value + 1)}>
        Increment
      </button>
      <span data-testid={`count-${name}`}>Count: {count}</span>
    </div>
  );
}
