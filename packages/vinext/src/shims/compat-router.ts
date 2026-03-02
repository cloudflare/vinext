/**
 * next/compat/router shim
 *
 * Designed for components that can be shared between app/ and pages/.
 * Unlike next/router, this hook returns null instead of throwing when
 * the Pages Router is not mounted (e.g., in App Router context).
 */
import { useContext } from "react";
import { RouterContext } from "./internal/router-context.js";

/**
 * Returns the NextRouter instance if the Pages Router is mounted,
 * otherwise returns null (e.g., when used inside app/).
 */
export function useRouter() {
  return useContext(RouterContext);
}
