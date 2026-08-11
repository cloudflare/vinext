import { extractStaticExportValue } from "../build/report.js";
import { validateAppRouteSegmentConfig } from "../server/app-segment-config.js";

type ValidateAppSegmentConfigSourceOptions = {
  cacheComponents: boolean;
  isClientModule: boolean;
  route: string;
};

/**
 * Validate statically analyzable App Router segment config during Vite's
 * module transform. Production builds traverse every page/layout/default
 * dynamic import, so invalid config fails the build without eagerly importing
 * every route into the generated RSC entry at worker startup.
 *
 * Unsupported expressions and cross-file re-exports are validated again from
 * their real module namespace when the route is resolved at runtime.
 */
export function validateAppSegmentConfigSource(
  code: string,
  options: ValidateAppSegmentConfigSourceOptions,
): void {
  const instant = extractStaticExportValue(code, "unstable_instant");
  if (!instant.found) return;

  if (options.isClientModule) {
    validateAppRouteSegmentConfig(
      { unstable_instant: false },
      {
        cacheComponents: options.cacheComponents,
        isClientModule: true,
        route: options.route,
      },
    );
  }

  if (!options.cacheComponents) {
    validateAppRouteSegmentConfig(
      { unstable_instant: false },
      { cacheComponents: false, route: options.route },
    );
  }

  const dynamicStaleTime = extractStaticExportValue(code, "unstable_dynamicStaleTime");
  if (dynamicStaleTime.found) {
    validateAppRouteSegmentConfig(
      { unstable_dynamicStaleTime: 0, unstable_instant: false },
      { cacheComponents: true, route: options.route },
    );
  }

  if (!instant.supported) return;
  validateAppRouteSegmentConfig(
    { unstable_instant: instant.value },
    { cacheComponents: true, route: options.route },
  );
}
