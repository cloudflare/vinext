import { matchRoutePattern } from "../routing/route-pattern.js";
import type { AppPageParams } from "./app-page-boundary.js";
import { SIBLING_PAGE_INTERCEPT_SLOT_KEY } from "./app-rsc-route-matching.js";

type AppPageNavigationParamModule = {
  default?: unknown;
};

export type AppPageNavigationParamSlot = {
  __loadDefault?: unknown;
  __loadPage?: unknown;
  default?: unknown;
  page?: unknown;
  slotPatternParts?: readonly string[] | null;
  slotParamNames?: readonly string[] | null;
};

type AppPageNavigationParamRoute = {
  params?: readonly string[] | null;
  slots?: Readonly<Record<string, AppPageNavigationParamSlot>> | null;
};

type AppPageNavigationParamInterceptOptions = {
  interceptPage?: unknown;
  interceptParams?: AppPageParams | null;
  interceptSlotKey?: string | null;
};

export function resolveSlotParamOverrides(
  route: AppPageNavigationParamRoute,
  routePath: string,
): Readonly<Record<string, AppPageParams>> | null {
  const overrides: Record<string, AppPageParams> = {};
  const slots = route.slots;
  if (slots) {
    let urlParts: string[] | null = null;
    const routeParamSet = collectParamNameSet(route.params);
    for (const [slotKey, slot] of Object.entries(slots)) {
      const patternParts = slot.slotPatternParts;
      const paramNames = slot.slotParamNames;
      if (!patternParts || patternParts.length === 0) continue;
      // Skip when every slot param is already a route param — the route's
      // matched params already carry the values the slot page expects.
      // Empty `paramNames` (slot pattern has no dynamic markers) also skips:
      // there's nothing to extract, so the route's matched params suffice.
      if (paramNames && paramNames.every((name) => routeParamSet.has(name))) continue;

      if (urlParts === null) {
        urlParts = routePath.split("/").filter(Boolean);
      }
      const matched = matchRoutePattern(urlParts, patternParts);
      if (!matched) continue;

      overrides[slotKey] = matched;
    }
  }

  return Object.keys(overrides).length > 0 ? overrides : null;
}

function mergeAppPageParams(target: AppPageParams, source: AppPageParams): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = value;
  }
}

function isDefaultExportModule(module: unknown): module is AppPageNavigationParamModule {
  return typeof module === "object" && module !== null;
}

function hasDefaultExport(module: unknown): boolean {
  if (!isDefaultExportModule(module)) return false;
  return module?.default !== null && module?.default !== undefined;
}

export function resolveAppPageNavigationParams(
  route: AppPageNavigationParamRoute,
  routeParams: AppPageParams,
  routePath: string,
  opts?: AppPageNavigationParamInterceptOptions | null,
): AppPageParams {
  const navigationParams: AppPageParams = { ...routeParams };
  const slotParamOverrides = resolveSlotParamOverrides(route, routePath);

  for (const [slotKey, slot] of Object.entries(route.slots ?? {})) {
    const isInterceptedSlot =
      opts?.interceptSlotKey === slotKey &&
      opts.interceptSlotKey !== SIBLING_PAGE_INTERCEPT_SLOT_KEY &&
      hasDefaultExport(opts.interceptPage);
    // A slot is considered active here if it exports a default component (page or fallback).
    // This is distinct from the optimistic-routing path (which keys off manifest bindings)
    // and the route graph (which keys off pagePath existence), but functionally equivalent
    // for param extraction today since default-only slots do not specify pattern parts.
    // The request stage of a staged deployment never loads slot modules, so a
    // lazy loader stands in for the module it would load.
    if (
      !isInterceptedSlot &&
      !hasDefaultExport(slot.page) &&
      !hasDefaultExport(slot.default) &&
      !slot.__loadPage &&
      !slot.__loadDefault
    ) {
      continue;
    }

    mergeAppPageParams(
      navigationParams,
      isInterceptedSlot
        ? (opts?.interceptParams ?? routeParams)
        : // Fallback to routeParams when slotParamOverrides missing — the slot
          // is active but contributes no new params (all its param names are
          // already route params, or the slot has no pattern parts). Merging
          // routeParams here is a deliberate no-op that keeps the loop uniform.
          (slotParamOverrides?.[slotKey] ?? routeParams),
    );
  }

  return navigationParams;
}

function collectParamNameSet(params: readonly string[] | undefined | null): Set<string> {
  const set = new Set<string>();
  if (params) {
    for (const name of params) set.add(name);
  }
  return set;
}
