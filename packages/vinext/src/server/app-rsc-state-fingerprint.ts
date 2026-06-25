import type { AppRouterState } from "./app-browser-state.js";

export type AppRscStateFingerprintInput = Pick<
  AppRouterState,
  "layoutIds" | "navigationSnapshot" | "rootLayoutTreePath" | "routeId" | "slotBindings"
>;

export function createAppRscStateFingerprint(state: AppRscStateFingerprintInput): string {
  return encodeURIComponent(
    JSON.stringify({
      layoutIds: state.layoutIds,
      pathname: state.navigationSnapshot.pathname,
      rootLayoutTreePath: state.rootLayoutTreePath,
      routeId: state.routeId,
      search: state.navigationSnapshot.searchParams.toString(),
      slotBindings: state.slotBindings,
    }),
  );
}
