type CachedNavigationRuntimeIntercept = {
  interceptLayouts?: readonly unknown[] | null;
  page?: unknown;
};

type CachedNavigationRuntimeSlot = {
  configLayouts?: readonly unknown[] | null;
  default?: unknown;
  intercepts?: readonly CachedNavigationRuntimeIntercept[] | null;
  layout?: unknown;
  page?: unknown;
};

type CachedNavigationRuntimeRoute = {
  layouts?: readonly unknown[] | null;
  page?: unknown;
  siblingIntercepts?: readonly CachedNavigationRuntimeIntercept[] | null;
  slots?: Readonly<Record<string, CachedNavigationRuntimeSlot>> | null;
};

type ActiveCachedNavigationRuntimeIntercept = {
  interceptLayouts?: readonly unknown[] | null;
  interceptPage?: unknown;
};

export function moduleUsesRuntimeCachedNavigations(module: unknown): boolean {
  if ((typeof module !== "object" || module === null) && typeof module !== "function") {
    return false;
  }
  const instant = Reflect.get(module, "unstable_instant");
  return (
    typeof instant === "object" &&
    instant !== null &&
    Reflect.get(instant, "prefetch") === "runtime"
  );
}

export function resolveCachedNavigationRuntimeModuleChain(
  modules: readonly unknown[],
  inherited = false,
): readonly boolean[] {
  let enabled = inherited;
  return modules.map((module) => {
    enabled ||= moduleUsesRuntimeCachedNavigations(module);
    return enabled;
  });
}

export function resolveCachedNavigationRuntimeRenderAction(options: {
  eligible: boolean;
  omitWhenDisabled: boolean;
  stage: "navigation" | "runtime" | "static" | null;
}): "omit" | "render" | "suspend" {
  if (options.stage !== "runtime" || options.eligible) return "render";
  return options.omitWhenDisabled ? "omit" : "suspend";
}

export function routeUsesRuntimeCachedNavigations(
  route: CachedNavigationRuntimeRoute,
  activeIntercept?: ActiveCachedNavigationRuntimeIntercept | null,
): boolean {
  if ([...(route.layouts ?? []), route.page].some(moduleUsesRuntimeCachedNavigations)) {
    return true;
  }

  if (
    Object.values(route.slots ?? {}).some((slot) =>
      [slot.layout, ...(slot.configLayouts ?? []), slot.page, slot.default].some(
        moduleUsesRuntimeCachedNavigations,
      ),
    )
  ) {
    return true;
  }

  // Interception manifests contain every possible target and may keep their
  // page modules lazy. Only the request-selected intercept is authoritative;
  // scanning the manifest advertises inactive branches and misses a selected
  // request-local clone whose module was hydrated without mutating the base
  // route record.
  return activeIntercept
    ? [...(activeIntercept.interceptLayouts ?? []), activeIntercept.interceptPage].some(
        moduleUsesRuntimeCachedNavigations,
      )
    : false;
}
