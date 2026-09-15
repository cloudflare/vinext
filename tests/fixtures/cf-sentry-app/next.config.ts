import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default withSentryConfig(nextConfig, {
  // Sentry's source scanner classifies any route with generateStaticParams as
  // ISR and removes its trace metadata in the browser. This fixture route also
  // reads cookies, so exclude it to retain the live auto-dynamic continuation
  // assertion while leaving manifest parameterization enabled elsewhere.
  routeManifestInjection: { exclude: ["/trace-auto/:slug"] },
  silent: true,
  telemetry: false,
  sourcemaps: { disable: true },
  suppressOnRouterTransitionStartWarning: true,
  webpack: {
    treeshake: { removeDebugLogging: false },
  },
});
