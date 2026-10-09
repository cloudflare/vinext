import { createElement } from "react";
import dynamic from "next/dynamic";

// A next/dynamic() CALL SITE inside a package (node_modules), like a UI library
// that lazy-loads its own heavy widget. Next.js transforms third-party code in
// App Router layers, so the boundary's CSS must be linked server-side.
const HostedBanner = dynamic(() => import("./hosted-banner.js"));

export function DynamicHost() {
  return createElement(HostedBanner);
}
