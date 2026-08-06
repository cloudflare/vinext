import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default withSentryConfig(nextConfig, {
  silent: true,
  telemetry: false,
  sourcemaps: { disable: true },
  suppressOnRouterTransitionStartWarning: true,
  webpack: {
    treeshake: { removeDebugLogging: false },
  },
});
