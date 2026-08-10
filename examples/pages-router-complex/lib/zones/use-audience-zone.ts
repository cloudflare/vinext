import { useRouter } from "next/router";

import type { Zone } from "./zone";
import { zoneFromRouteQuery } from "./zone";

/** The active zone, read from the `[zone]` route param. */
export const useAudienceZone = (): Zone => {
  const router = useRouter();
  return zoneFromRouteQuery(router.query);
};
