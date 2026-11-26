import * as React from "react";

/**
 * Tag the current navigation Transition with the caller's view transition
 * types, so `<ViewTransition enter={{ "nav-back": ... }}>` can pick its
 * animation by type. Must be called synchronously inside the
 * `React.startTransition` callback that starts the navigation.
 *
 * Ported from Next.js: packages/next/src/client/components/app-router-instance.ts
 * (`navigate` calls `addTransitionType` for each of `transitionTypes`).
 *
 * `addTransitionType` exists from React 19.2. Older React has no view
 * transitions to tag, so the types are dropped.
 */
export function addNavigationTransitionTypes(types: readonly string[] | null | undefined): void {
  if (!types || types.length === 0) return;
  const addTransitionType = (React as { addTransitionType?: (type: string) => void })
    .addTransitionType;
  if (typeof addTransitionType !== "function") return;
  for (const type of types) addTransitionType(type);
}
