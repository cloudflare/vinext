import { resolveAppPageSpecialError } from "./app-page-execution.js";

/**
 * Holds an RSC response until the layouts above the route's first loading
 * boundary have rendered, so that a layout's redirect(), notFound(),
 * forbidden() or unauthorized() still answers the request: a redirect through
 * the `X-Vinext-Rsc-Redirect` side channel, and the others with their
 * boundary's status. The layouts render once, in the render itself. A
 * signal from a component a layout renders streams in the payload, as in
 * Next.js.
 */
export type AppPageLayoutGate = {
  /** Holds the response until the layout with `layoutId` has rendered. */
  hold(layoutId: string, layoutIndex: number): void;
  /** Reports how the layout with `layoutId` rendered. */
  settle(layoutId: string, failure?: { error: unknown }): void;
  /**
   * Stops waiting when the render threw an error that may end it before every
   * held layout renders. A redirect(), notFound(), forbidden() or
   * unauthorized() doesn't, such as the page's: it renders before its layouts.
   */
  observeRenderError(error: unknown): void;
  /**
   * The outermost held layout that threw, once every held layout `isRendered`
   * includes has rendered, or null.
   */
  wait(isRendered: (layoutId: string) => boolean): Promise<AppPageLayoutGateFailure | null>;
};

export type AppPageLayoutGateFailure = {
  error: unknown;
  layoutIndex: number;
};

export function createAppPageLayoutGate(): AppPageLayoutGate {
  const held = new Map<string, number>();
  const settled = new Set<string>();
  const failures = new Set<unknown>();
  let failure: AppPageLayoutGateFailure | null = null;
  let opened = false;
  let check: (() => void) | null = null;

  return {
    hold(layoutId, layoutIndex) {
      held.set(layoutId, layoutIndex);
    },
    settle(layoutId, layoutFailure) {
      const layoutIndex = held.get(layoutId);
      if (layoutIndex === undefined || settled.has(layoutId)) return;
      settled.add(layoutId);
      if (layoutFailure) {
        failures.add(layoutFailure.error);
        // The outermost layout's signal is the one its boundary shows.
        if (failure === null || layoutIndex < failure.layoutIndex) {
          failure = { error: layoutFailure.error, layoutIndex };
        }
      }
      check?.();
    },
    observeRenderError(error) {
      if (failures.has(error) || resolveAppPageSpecialError(error) !== null) return;
      opened = true;
      check?.();
    },
    wait(isRendered) {
      return new Promise((resolve) => {
        check = () => {
          for (const layoutId of held.keys()) {
            if (!opened && !settled.has(layoutId) && isRendered(layoutId)) return;
          }
          check = null;
          resolve(failure);
        };
        check();
      });
    },
  };
}

const appPageLayoutGates = new WeakMap<object, AppPageLayoutGate>();

export function registerAppPageLayoutGate(elements: object, gate: AppPageLayoutGate): void {
  appPageLayoutGates.set(elements, gate);
}

/** The gate of the layouts in `element`, an App Router elements record. */
export function getAppPageLayoutGate(element: unknown): AppPageLayoutGate | null {
  return typeof element === "object" && element !== null
    ? (appPageLayoutGates.get(element) ?? null)
    : null;
}
