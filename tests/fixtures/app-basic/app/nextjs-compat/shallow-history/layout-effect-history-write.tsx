"use client";

import { useLayoutEffect } from "react";
import { usePathname } from "next/navigation";

export function LayoutEffectHistoryWrite() {
  const pathname = usePathname();

  useLayoutEffect(() => {
    if (window.location.search !== "?layout-effect=push") return;
    window.history.pushState({}, "", `${window.location.pathname}?layout-effect=committed`);
  }, []);

  return <pre id="layout-effect-pathname">{pathname}</pre>;
}
