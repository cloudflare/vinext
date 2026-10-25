import { createElement } from "react";
import classes from "./dynamic-banner.module.css";

// Lazy-loaded by app/nextjs-compat/dynamic/out-of-root-package via next/dynamic.
// This package resolves through the workspace-root pnpm store, OUTSIDE the
// fixture's Vite root, so its client manifest key carries `../` segments.
export default function DynamicBanner() {
  return createElement(
    "p",
    { id: "out-of-root-dynamic-banner", className: classes.banner },
    "out-of-root dynamic banner",
  );
}
