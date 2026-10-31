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
   * The outermost held layout that has thrown so far, or null. A document
   * whose shell an error rejected reads it to find the layout that threw.
   */
  failure(): AppPageLayoutGateFailure | null;
  /**
   * The outermost held layout that threw, once every held layout `isRendered`
   * includes has rendered, or null. An error elsewhere in the render doesn't
   * stop the wait, as Flight goes on to render the other entries, but the
   * render ending does: `ended` settles when its stream closes or errors.
   */
  wait(
    isRendered: (layoutId: string) => boolean,
    ended: Promise<unknown>,
  ): Promise<AppPageLayoutGateFailure | null>;
};

export type AppPageLayoutGateFailure = {
  error: unknown;
  layoutIndex: number;
};

export function createAppPageLayoutGate(): AppPageLayoutGate {
  const held = new Map<string, number>();
  const settled = new Set<string>();
  let failure: AppPageLayoutGateFailure | null = null;
  let ended = false;
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
        // The outermost layout's signal is the one its boundary shows.
        if (failure === null || layoutIndex < failure.layoutIndex) {
          failure = { error: layoutFailure.error, layoutIndex };
        }
      }
      check?.();
    },
    failure() {
      return failure;
    },
    wait(isRendered, renderEnded) {
      return new Promise((resolve) => {
        check = () => {
          for (const layoutId of held.keys()) {
            if (!ended && !settled.has(layoutId) && isRendered(layoutId)) return;
          }
          check = null;
          resolve(failure);
        };
        const end = () => {
          ended = true;
          check?.();
        };
        renderEnded.then(end, end);
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
