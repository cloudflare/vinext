"use client";

import { useState } from "react";
import { useEffect } from "react";

declare global {
  interface Window {
    __VINEXT_PREFETCH_FALSE_LOADING_LAYOUT_MOUNTS__?: number;
  }
}

export function SharedLayoutMountMarker() {
  const [mountId, setMountId] = useState(0);

  useEffect(() => {
    window.__VINEXT_PREFETCH_FALSE_LOADING_LAYOUT_MOUNTS__ =
      (window.__VINEXT_PREFETCH_FALSE_LOADING_LAYOUT_MOUNTS__ ?? 0) + 1;
    setMountId(window.__VINEXT_PREFETCH_FALSE_LOADING_LAYOUT_MOUNTS__);
  }, []);

  return <p id="shared-layout-mount-id">{mountId}</p>;
}
