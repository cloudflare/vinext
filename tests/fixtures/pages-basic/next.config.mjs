/** @type {import('next').NextConfig} */
const nextConfig = {
  pageExtensions: ["js", "jsx", "ts", "tsx", "mdx"],
  generateBuildId: () => "test-build-id",
  env: {
    CUSTOM_VAR: "hello-from-config",
  },
  experimental: {
    allowedRevalidateHeaderKeys: ["x-revalidate-token"],
  },
  async redirects() {
    return [
      {
        source: "/old-about",
        destination: "/about",
        permanent: true,
      },
      {
        source: "/repeat-redirect/:id",
        destination: "/docs/:id/:id",
        permanent: false,
      },
      {
        source: "/redirect-before-middleware-rewrite",
        destination: "/about",
        permanent: false,
      },
      {
        source: "/redirect-before-middleware-response",
        destination: "/about",
        permanent: false,
      },
      // Used by E2E: pages-router-prod/config-query-params.spec.ts — source
      // params substituted into a redirect destination query.
      {
        source: "/query-param-redirect/:next",
        destination: "/about?next=/:next&safe=1",
        permanent: false,
      },
      // Used by E2E: pages-router-prod/redirect-conditions.spec.ts — header and
      // cookie condition values are server-only and must stay out of the
      // public client bundle.
      {
        source: "/server-condition-redirect/header",
        destination: "/about",
        permanent: false,
        has: [
          {
            type: "header",
            key: "x-redirect-capability",
            value: "header-capability-5f0c2e",
          },
        ],
      },
      {
        source: "/server-condition-redirect/shadowed",
        destination: "/about",
        permanent: false,
        has: [
          {
            type: "cookie",
            key: "redirect-capability",
            value: "cookie-capability-9a41d7",
          },
        ],
      },
      {
        source: "/server-condition-redirect/shadowed",
        destination: "/nav-test",
        permanent: false,
      },
      {
        source: "/server-condition-redirect/component-only",
        destination: "/about",
        permanent: false,
        has: [
          {
            type: "cookie",
            key: "redirect-capability",
            value: "cookie-capability-9a41d7",
          },
        ],
      },
    ];
  },
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/before-rewrite",
          destination: "/about",
        },
        {
          source: "/repeat-rewrite/:id",
          destination: "/docs/:id/:id",
        },
        // Used by E2E: pages-router-prod/config-query-params.spec.ts — a source
        // param substituted into a destination query value must stay one value
        // on the server and in the client router's beforeFiles rewrite resolution.
        {
          source: "/query-param-rewrite/:term",
          destination: "/ssr-query?q=:term&fixed=1",
        },
        // The `api` prefix keeps this source outside the fixture middleware
        // matcher, so a soft navigation takes its query from the client
        // router's own rewrite resolution instead of a middleware data probe.
        {
          source: "/api-query-param-rewrite/:term",
          destination: "/rewrite-navigation/0/destination?q=:term&fixed=1",
        },
        {
          source: "/rewrite-navigation/:id",
          destination: "/rewrite-navigation/:id/destination",
        },
        // Ported from Next.js:
        // test/e2e/use-router-with-rewrites/use-router-with-rewrites.test.ts
        // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/use-router-with-rewrites/use-router-with-rewrites.test.ts
        {
          source: "/rewrite-navigation-same/1",
          destination: "/rewrite-navigation-same/001",
        },
        {
          source: "/rewrite-navigation-same/2",
          destination: "/rewrite-navigation-same/002",
        },
        {
          source: "/rewrite-navigation-same/3",
          destination: "/rewrite-navigation-same/003",
        },
        // Used by Vitest: pages-router.test.ts — beforeFiles rewrite gated on
        // a cookie injected by middleware. Middleware injects mw-before-user=1
        // when ?mw-auth is present. The beforeFiles rewrite should see this
        // cookie because beforeFiles runs after middleware per Next.js docs.
        {
          source: "/mw-gated-before",
          has: [{ type: "cookie", key: "mw-before-user" }],
          destination: "/about",
        },
      ],
      afterFiles: [
        {
          source: "/after-rewrite",
          destination: "/about",
        },
        {
          source: "/nav-test",
          destination: "/about",
        },
        // Used by Vitest: pages-router.test.ts — afterFiles rewrite gated on
        // a cookie injected by middleware. Middleware injects mw-user=1 via
        // x-middleware-request-cookie when ?mw-auth is present. The afterFiles
        // rewrite should see this cookie because afterFiles runs after middleware.
        {
          source: "/mw-gated-rewrite",
          has: [{ type: "cookie", key: "mw-user" }],
          destination: "/about",
        },
      ],
      fallback: [
        {
          source: "/fallback-rewrite",
          destination: "/about",
        },
      ],
    };
  },
  async headers() {
    return [
      {
        source: "/storage-policy/short-browser",
        headers: [{ key: "Cache-Control", value: "public, max-age=1" }],
      },
      {
        source: "/storage-policy/long-browser",
        headers: [{ key: "Cache-Control", value: "private, max-age=300" }],
      },
      {
        source: "/storage-policy/no-store",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },

      {
        source: "/api/(.*)",
        headers: [
          {
            key: "X-Custom-Header",
            value: "vinext",
          },
        ],
      },
      // Used by Vitest: pages-router.test.ts — has/missing conditions on headers
      // Ported from PR #47 by @ibruno
      {
        source: "/about",
        has: [{ type: "cookie", key: "logged-in" }],
        headers: [{ key: "X-Auth-Only-Header", value: "1" }],
      },
      {
        source: "/about",
        missing: [{ type: "cookie", key: "logged-in" }],
        headers: [{ key: "X-Guest-Only-Header", value: "1" }],
      },
      {
        source: "/about",
        headers: [{ key: "X-Page-Header", value: "about-page" }],
      },
      // Test that Vary headers from config are additive (append, not replace)
      {
        source: "/ssr",
        headers: [{ key: "Vary", value: "Accept-Language" }],
      },
      {
        source: "/headers-before-middleware-rewrite",
        headers: [{ key: "X-Rewrite-Source-Header", value: "1" }],
      },
    ];
  },
};

export default nextConfig;
