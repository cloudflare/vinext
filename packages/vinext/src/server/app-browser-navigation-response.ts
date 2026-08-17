import type { ClientNavigationRenderSnapshot } from "vinext/shims/navigation";
import { stripBasePath } from "../utils/base-path.js";

export function shouldRecoverSamePathSearchCommitOnResponseCompletion(options: {
  basePath: string;
  currentSnapshot: ClientNavigationRenderSnapshot;
  navigationKind: "navigate" | "traverse" | "refresh";
  programmaticTransition: boolean;
  targetUrl: URL;
}): boolean {
  if (!options.programmaticTransition || options.navigationKind !== "navigate") {
    return false;
  }

  return (
    options.currentSnapshot.pathname ===
      stripBasePath(options.targetUrl.pathname, options.basePath) &&
    options.currentSnapshot.search !== options.targetUrl.search
  );
}
