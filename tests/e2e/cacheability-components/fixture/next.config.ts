// @ts-nocheck
// This isolated non-workspace fixture receives its dependencies from the
// Playwright web-server setup immediately before the production build.
import type { NextConfig } from "vinext";

export default {
  cacheComponents: true,
  generateBuildId: () => "cacheability-components-e2e",
} satisfies NextConfig;
