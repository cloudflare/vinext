"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { openConnection, recordMount, recordView } from "./effect-log";

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

// Models a page-view tracker: hidden entries run no effects, so only the URL a
// visible entry commits with is recorded.
export function PageViewProbe({ name }: { name: string }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  // A spec can make the probe write the URL from a layout effect the next time
  // it's shown, like a component that syncs its state to the URL.
  useLayoutEffect(() => {
    const flags = window as Window & { __writeUrlOnShow?: string };
    if (flags.__writeUrlOnShow !== name) return;
    delete flags.__writeUrlOnShow;
    window.history.replaceState(null, "", "?shown=1");
  }, [name]);
  useEffect(() => {
    recordView(name, search ? `${pathname}?${search}` : pathname);
  }, [name, pathname, search]);
  return null;
}
