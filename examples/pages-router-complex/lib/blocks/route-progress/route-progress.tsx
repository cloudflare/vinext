import type { ReactNode } from "react";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { useRouter } from "next/router";

import { emitBeacon } from "../../beacon/emit";
import {
  hasPending,
  holdPending,
  releasePending,
  subscribePending,
} from "./pending-ledger";

const ROUTE_CHANGE_KEY = "route-change";
const ROUTE_CHANGE_TIMEOUT_MS = 3000;

export type RouteProgressProps = {
  children?: ReactNode;
};

/**
 * Self-managed transition overlay. Subscribes to the pages-router event
 * emitter: `routeChangeStart` holds a pending key (with a failsafe timeout so
 * a hung transition can't wedge the overlay), `routeChangeComplete` /
 * `routeChangeError` release it. Each event also emits a beacon so the
 * ordering is observable from tests.
 */
export const RouteProgress = ({ children }: RouteProgressProps) => {
  const inFlight = useSyncExternalStore(
    subscribePending,
    hasPending,
    () => false,
  );
  const router = useRouter();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(() => {
    const clearFailsafe = () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = undefined;
      }
    };

    const onRouteChangeStart = () => {
      emitBeacon("route-change", { phase: "start" });
      clearFailsafe();
      holdPending(ROUTE_CHANGE_KEY);

      timeoutRef.current = setTimeout(() => {
        releasePending(ROUTE_CHANGE_KEY);
      }, ROUTE_CHANGE_TIMEOUT_MS);
    };

    const onRouteChangeComplete = () => {
      emitBeacon("route-change", { phase: "complete" });
      clearFailsafe();
      releasePending(ROUTE_CHANGE_KEY);
    };

    const onRouteChangeError = () => {
      emitBeacon("route-change", { phase: "error" });
      clearFailsafe();
      releasePending(ROUTE_CHANGE_KEY);
    };

    router.events.on("routeChangeStart", onRouteChangeStart);
    router.events.on("routeChangeComplete", onRouteChangeComplete);
    router.events.on("routeChangeError", onRouteChangeError);

    return () => {
      clearFailsafe();
      router.events.off("routeChangeStart", onRouteChangeStart);
      router.events.off("routeChangeComplete", onRouteChangeComplete);
      router.events.off("routeChangeError", onRouteChangeError);
    };
  }, [router]);

  return (
    <div data-testid="route-progress" data-in-flight={inFlight || undefined}>
      {children}
    </div>
  );
};
