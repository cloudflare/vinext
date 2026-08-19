import { normalizePathnameForRouteMatch } from "../routing/utils.js";
import { normalizePath } from "./normalize-path.js";
import { removeTrailingSlash, stripBasePath } from "../utils/base-path.js";

export const RSC_PREWARM_MANIFEST_META_NAME = "vinext-rsc-prewarm-manifest";

export function normalizeRscPrewarmPath(pathname: string, basePath = ""): string {
  return removeTrailingSlash(
    normalizePath(normalizePathnameForRouteMatch(stripBasePath(pathname, basePath))),
  );
}
