import { mergeElements } from "../shims/slot.js";
import { readAppElementsMetadata, type AppElements } from "./app-elements.js";
import type { ClientNavigationRenderSnapshot } from "../shims/navigation.js";

export type AppRouterState = {
  elements: AppElements;
  renderId: number;
  navigationSnapshot: ClientNavigationRenderSnapshot;
  rootLayoutTreePath: string | null;
  routeId: string;
};

export type AppRouterAction = {
  elements: AppElements;
  navigationSnapshot: ClientNavigationRenderSnapshot;
  renderId: number;
  rootLayoutTreePath: string | null;
  routeId: string;
  type: "navigate" | "replace" | "traverse";
};

export type PendingNavigationCommit = {
  action: AppRouterAction;
  rootLayoutTreePath: string | null;
  routeId: string;
};

export type PendingNavigationCommitDisposition = "dispatch" | "hard-navigate" | "skip";
export type ClassifiedPendingNavigationCommit = {
  disposition: PendingNavigationCommitDisposition;
  pending: PendingNavigationCommit;
};

export function routerReducer(state: AppRouterState, action: AppRouterAction): AppRouterState {
  switch (action.type) {
    case "traverse":
    case "navigate":
      return {
        elements: mergeElements(state.elements, action.elements, action.type === "traverse"),
        navigationSnapshot: action.navigationSnapshot,
        renderId: action.renderId,
        rootLayoutTreePath: action.rootLayoutTreePath,
        routeId: action.routeId,
      };
    case "replace":
      return {
        elements: action.elements,
        navigationSnapshot: action.navigationSnapshot,
        renderId: action.renderId,
        rootLayoutTreePath: action.rootLayoutTreePath,
        routeId: action.routeId,
      };
    default: {
      const _exhaustive: never = action.type;
      throw new Error("[vinext] Unknown router action: " + String(_exhaustive));
    }
  }
}

export function shouldHardNavigate(
  currentRootLayoutTreePath: string | null,
  nextRootLayoutTreePath: string | null,
): boolean {
  // `null` means the payload could not identify an enclosing root layout
  // boundary. Treat that as soft-navigation compatible so fallback payloads
  // do not force a hard reload purely because metadata is absent.
  return (
    currentRootLayoutTreePath !== null &&
    nextRootLayoutTreePath !== null &&
    currentRootLayoutTreePath !== nextRootLayoutTreePath
  );
}

export function resolvePendingNavigationCommitDisposition(options: {
  activeNavigationId: number;
  currentRootLayoutTreePath: string | null;
  nextRootLayoutTreePath: string | null;
  startedNavigationId: number;
}): PendingNavigationCommitDisposition {
  if (options.startedNavigationId !== options.activeNavigationId) {
    return "skip";
  }

  if (shouldHardNavigate(options.currentRootLayoutTreePath, options.nextRootLayoutTreePath)) {
    return "hard-navigate";
  }

  return "dispatch";
}

export async function createPendingNavigationCommit(options: {
  currentState: AppRouterState;
  nextElements: Promise<AppElements>;
  navigationSnapshot: ClientNavigationRenderSnapshot;
  renderId: number;
  type: "navigate" | "replace" | "traverse";
}): Promise<PendingNavigationCommit> {
  const elements = await options.nextElements;
  const metadata = readAppElementsMetadata(elements);

  return {
    action: {
      elements,
      navigationSnapshot: options.navigationSnapshot,
      renderId: options.renderId,
      rootLayoutTreePath: metadata.rootLayoutTreePath,
      routeId: metadata.routeId,
      type: options.type,
    },
    rootLayoutTreePath: metadata.rootLayoutTreePath,
    routeId: metadata.routeId,
  };
}

export async function resolveAndClassifyNavigationCommit(options: {
  activeNavigationId: number;
  currentState: AppRouterState;
  navigationSnapshot: ClientNavigationRenderSnapshot;
  nextElements: Promise<AppElements>;
  renderId: number;
  startedNavigationId: number;
  type: "navigate" | "replace" | "traverse";
}): Promise<ClassifiedPendingNavigationCommit> {
  const pending = await createPendingNavigationCommit({
    currentState: options.currentState,
    nextElements: options.nextElements,
    navigationSnapshot: options.navigationSnapshot,
    renderId: options.renderId,
    type: options.type,
  });

  return {
    disposition: resolvePendingNavigationCommitDisposition({
      activeNavigationId: options.activeNavigationId,
      currentRootLayoutTreePath: options.currentState.rootLayoutTreePath,
      nextRootLayoutTreePath: pending.rootLayoutTreePath,
      startedNavigationId: options.startedNavigationId,
    }),
    pending,
  };
}
