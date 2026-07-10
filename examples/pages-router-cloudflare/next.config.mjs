export default {
  async headers() {
    return [
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
      beforeFiles: [
        {
          source: "/external-prefix/:path*",
          destination: "http://127.0.0.1:4231/v1/:path*",
        },
      ],
      afterFiles: [{ source: "/nav-test", destination: "/about" }],
      fallback: [],
    };
  },
};
