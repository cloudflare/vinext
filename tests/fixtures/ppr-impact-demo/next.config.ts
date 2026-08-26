import type { NextConfig } from "vinext";

export default {
  cacheComponents: true,
  generateBuildId: () => "ppr-impact-demo-cacheability",
} satisfies NextConfig;
