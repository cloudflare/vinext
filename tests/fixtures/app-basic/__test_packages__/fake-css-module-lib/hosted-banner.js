import { createElement } from "react";
import classes from "./hosted-banner.module.css";

// Lazy-loaded by ./dynamic-host.js — the dynamic() call lives in this package.
export default function HostedBanner() {
  return createElement(
    "p",
    { id: "node-modules-dynamic-banner", className: classes.banner },
    "node_modules dynamic banner",
  );
}
