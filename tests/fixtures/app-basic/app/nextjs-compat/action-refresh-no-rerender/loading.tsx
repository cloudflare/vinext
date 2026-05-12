"use client";

import { useEffect } from "react";

declare global {
  interface Window {
    __VINEXT_ACTION_REFRESH_STARTED__?: boolean;
  }
}

export default function Loading() {
  useEffect(() => {
    if (window.__VINEXT_ACTION_REFRESH_STARTED__ === true) {
      console.log("Action refresh loading mounted");
    }
  }, []);

  return <p id="action-refresh-loading">Action refresh loading...</p>;
}
