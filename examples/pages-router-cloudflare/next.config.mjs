export default {
  async headers() {
    return [
      {
        source: "/about",
        headers: [{ key: "X-Page-Header", value: "about-page" }],
      },
      {
        source: "/headers-before-middleware-rewrite",
        headers: [{ key: "x-rewrite-source-header", value: "1" }],
      },
    ];
  },

  async redirects() {
    return [
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
    ];
  },

  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [
        { source: "/nav-test", destination: "/about" },
        { source: "/rewrite-about", destination: "/about" },
      ],
      fallback:
        process.env.VINEXT_E2E_REVALIDATION_PROXY === "1"
          ? [
              {
                source: "/external-revalidate-proxy",
                destination: "http://127.0.0.1:43199/revalidation-capture",
              },
            ]
          : [],
    };
  },
};
