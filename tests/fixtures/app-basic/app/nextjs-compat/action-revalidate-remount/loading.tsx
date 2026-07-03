"use client";

import { useEffect } from "react";

declare global {
  interface Window {
    __VINEXT_REVALIDATE_REMOUNT_STARTED__?: boolean;
  }
}

export default function Loading() {
  useEffect(() => {
    if (window.__VINEXT_REVALIDATE_REMOUNT_STARTED__ === true) {
      console.log("Revalidate remount loading mounted");
    }
  }, []);

  return <p id="revalidate-remount-loading">loading...</p>;
}
