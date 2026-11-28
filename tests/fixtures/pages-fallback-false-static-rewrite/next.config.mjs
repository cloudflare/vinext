// A fallback rewrite to a missing build asset, reached once the root
// `fallback: false` catch-all rejects the path.
export default {
  async rewrites() {
    return {
      fallback: [{ source: "/:path*", destination: "/_next/static/missing.js" }],
    };
  },
};
