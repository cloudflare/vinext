/**
 * The React side of `experimental.useOffline`: the context `useOffline()`
 * (next/offline) reads, and the provider the App Router root mounts under the
 * flag (Next.js's packages/next/src/client/components/use-offline.tsx). Kept
 * out of next/offline so that module exports only what Next.js's does.
 */
"use client";

import {
  createContext,
  createElement,
  startTransition,
  useContext,
  useOptimistic,
  useState,
} from "react";
import type { ReactNode } from "react";
import { setOfflineChangeListener } from "./offline.js";

const OfflineContext = createContext(false);

/**
 * Mirrors the offline state into React. Mounted by the App Router root when
 * `experimental.useOffline` is set.
 *
 * The canonical state updates in a transition, and the optimistic copy shows
 * it at once even while a navigation transition is pending and stuck waiting
 * for the network, which is exactly when the reader needs to see it.
 */
export function OfflineProvider({ children }: { children?: ReactNode }) {
  const [canonicalOffline, setCanonicalOffline] = useState(false);
  const [isOffline, setOptimisticOffline] = useOptimistic(canonicalOffline);
  setOfflineChangeListener((offline) => {
    startTransition(() => {
      setCanonicalOffline(offline);
      setOptimisticOffline(offline);
    });
  });
  return createElement(OfflineContext.Provider, { value: isOffline }, children);
}

export function useOffline(): boolean {
  return useContext(OfflineContext);
}
