import type { NextConfig } from "vinext";

export default {
  cacheComponents: true,
  generateBuildId: () => "cacheability-components-e2e",
} satisfies NextConfig;
