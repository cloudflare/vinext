import { normalizePathnameForRouteMatch } from "../routing/utils.js";
import { removeTrailingSlash, stripBasePath } from "./base-path.js";
import { normalizePath } from "./normalize-path.js";

export const RSC_PREWARM_MANIFEST_META_NAME = "vinext-rsc-prewarm-manifest";

export function normalizeRscPrewarmPath(pathname: string, basePath = ""): string {
  return removeTrailingSlash(
    normalizePath(normalizePathnameForRouteMatch(stripBasePath(pathname, basePath))),
  );
}
