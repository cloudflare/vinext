import { useEffect } from "react";

import { useRouter } from "next/compat/router";
import { usePathname } from "next/navigation";

const routerEvent = "routeChangeStart";

declare global {
  interface Window {
    __ATLAS_TRIALS_ACTIVE__?: string[];
  }
}

const resetTrialMarks = () => {
  if (window.__ATLAS_TRIALS_ACTIVE__) {
    window.__ATLAS_TRIALS_ACTIVE__ = [];
  }
};

/**
 * Clears the per-page trial marks on navigation. Written router-agnostically
 * on purpose (the shared module serves both router flavours): the compat
 * router is non-null under the pages router — subscribe to its events — and
 * null under the app router, where pathname changes are the trigger.
 */
export const useResetTrialMarks = () => {
  const router = useRouter();
  const pathname = usePathname();

  // Pages Router: use router events
  useEffect(() => {
    if (!router) {
      return;
    }

    router.events.on(routerEvent, resetTrialMarks);

    return () => {
      router.events.off(routerEvent, resetTrialMarks);
    };
  }, [router]);

  // App Router: use pathname changes as the trigger
  useEffect(() => {
    if (router) {
      return;
    }

    resetTrialMarks();
  }, [pathname, router]);
};
