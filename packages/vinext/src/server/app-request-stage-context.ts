import { setHeadersContext } from "vinext/shims/headers";
import { setRootParams } from "vinext/shims/root-params";

/** The request stage does not render user code, so it owns no navigation context. */
export function setAppRequestStageNavigationContext(): void {}

export function clearAppRequestStageContext(): void {
  setHeadersContext(null);
  setRootParams(null);
}
