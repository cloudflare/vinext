// @ts-check

const path = require("path");

/**
 * House-style config composition: the exported value is an async function of
 * `(phase, context)` — the framework must call it with the current PHASE_*
 * constant — and each decorator below layers one concern onto the base.
 */
const composeConfig = (base, decorators) =>
  async function resolveConfig(phase, context) {
    let resolved = base;
    for (const decorate of decorators) {
      resolved = await decorate(resolved, phase, context);
    }
    return resolved;
  };

const isDev = process.env.NODE_ENV === "development";

/** Legacy docs routes still served by the old documentation platform. */
const legacyDocsProxy = {
  origin: process.env.ATLAS_DOCS_PROXY_ORIGIN,
  routes: {
    guides: "/guides",
    policies: "/policies",
    statusPage: "/status-page",
  },
};

/**
 * @type {import('next').NextConfig}
 **/
const baseConfig = {
  pageExtensions: ["page.tsx", "page.ts"],
  poweredByHeader: false,
  productionBrowserSourceMaps: true,
  // The middleware inspects raw /_next/data URLs (the hardNavTo branch), so
  // the framework must not normalise them to page paths first.
  skipMiddlewareUrlNormalize: true,
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../../"),
  assetPrefix: isDev ? undefined : "/atlas/cdn/",
  generateBuildId() {
    if (!process.env.RELEASE_TAG) {
      throw new Error("RELEASE_TAG must be set to build this app");
    }
    return `atlas-${process.env.RELEASE_TAG}`;
  },
  images: {
    deviceSizes: [480, 828, 1200, 1920],
    remotePatterns: [
      { protocol: "https", hostname: "**media.atlas-fixture.test" },
      // imgproxy widths are produced by the custom loader in lib/look
      {
        protocol: "https",
        hostname: "tailored-frontdoor.atlas-fixture.test",
        pathname: "/imgproxy/**",
      },
    ],
  },
  async rewrites() {
    const fallback = legacyDocsProxy.origin
      ? Object.values(legacyDocsProxy.routes).map((route) => ({
          source: `${route}/:slug*`,
          destination: `${legacyDocsProxy.origin}${route}/:slug*`,
        }))
      : [];
    return {
      beforeFiles: [],
      afterFiles: [
        { source: "/legacy/gateway/type-ahead", destination: "/api/type-ahead" },
      ],
      fallback,
    };
  },
  webpack(config, { isServer, webpack }) {
    // The workspace alias belongs to the tooling layer so it applies no
    // matter how the framework parses tsconfig; tsconfig `paths` stays
    // authoritative for the type checker.
    config.resolve = config.resolve ?? {};
    config.resolve.alias = {
      ...config.resolve.alias,
      "@atlas": path.join(__dirname, "lib"),
    };

    if (!isServer && webpack) {
      // Test-only modules must never reach the browser bundle; substituting
      // at module-resolution level beats aliasing (which the framework's
      // polyfill handling can override).
      config.plugins = config.plugins ?? [];
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /outbound-stub\/install-outbound-stub/,
          require.resolve("./void-module.js"),
        ),
      );
    }

    return config;
  },
};

module.exports = composeConfig(baseConfig, [
  // Hardening decorator: strips headers we never want, whatever the base says.
  (config) => ({ ...config, poweredByHeader: false }),
]);
