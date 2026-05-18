"use client";

import { useEffect } from "react";
import Router from "next/router";

declare global {
  interface Window {
    __NEXT_ROUTER_IMPORTED__?: boolean;
  }
}

export function RouterImporter() {
  useEffect(() => {
    window.__NEXT_ROUTER_IMPORTED__ = typeof Router.beforePopState === "function";
  }, []);

  return <p id="router-shim-imported">router shim imported</p>;
}
