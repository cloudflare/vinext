// Type-checked by tests/next-config-types.test.ts: the drop-in `next` types
// accept the next.config options vinext supports ahead of the vendored ones.
import type { NextConfig } from "next";

export const config: NextConfig = {
  experimental: { instrumentationClientRouterTransitionEvents: true },
  instrumentationClientInject: ["@example/instrumentation"],
};
