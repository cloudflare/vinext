"use client";

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { openConnection, recordMount } from "./effect-log";

// Models a component that opens a live connection on mount (a chat stream,
// a subscription) and keeps local state the user has built up.
export function useEffectProbe(name: string): RefObject<number | null> {
  // Numbered on the first committed setup. Refs survive while an Activity
  // entry is hidden, so showing it again reuses the number; a remount doesn't.
  const instance = useRef<number | null>(null);
  useEffect(() => {
    instance.current ??= recordMount(name);
    return openConnection(`${name}#${instance.current}`);
  }, [name]);
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
