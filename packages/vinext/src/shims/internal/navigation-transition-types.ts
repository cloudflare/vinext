import * as React from "react";

/**
 * Tag the current Transition with a navigation's view transition types
 * (`<Link transitionTypes>`, `router.push(href, { transitionTypes })`), so a
 * `<ViewTransition>` keyed by type picks its animation. Call it synchronously
 * inside the `startTransition` callback whose update commits the navigation.
 *
 * Ported from Next.js `dispatchNavigateAction`
 * (packages/next/src/client/components/app-router-instance.ts), which calls
 * `addTransitionType` for each type inside the navigation's transition.
 */
export function addNavigationTransitionTypes(types: readonly string[] | null | undefined): void {
  if (!types || types.length === 0) return;
  const addTransitionType = (React as { addTransitionType?: (type: string) => void })
    .addTransitionType;
  if (typeof addTransitionType !== "function") return;
  for (const type of types) addTransitionType(type);
}
