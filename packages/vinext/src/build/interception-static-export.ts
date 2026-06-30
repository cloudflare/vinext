import type { AppRoute } from "../routing/app-router.js";

export function assertNoStaticExportInterceptionRoutes(routes: readonly AppRoute[]): void {
  const hasInterceptionRoutes = routes.some(
    (route) =>
      route.siblingIntercepts.length > 0 ||
      route.parallelSlots.some((slot) => slot.interceptingRoutes.length > 0),
  );

  if (hasInterceptionRoutes) {
    throw new Error("Intercepting routes are not supported with static export.");
  }
}
