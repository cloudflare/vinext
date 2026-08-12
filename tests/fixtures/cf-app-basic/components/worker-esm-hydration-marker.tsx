"use client";

import { useEffect } from "react";

export function WorkerEsmHydrationMarker({ pathname }: { pathname: string }) {
  useEffect(() => {
    document.body.dataset.workerEsmHydrated = pathname;
  }, [pathname]);

  return null;
}
