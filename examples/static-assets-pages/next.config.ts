export default {
  // Inline at build time. Only local E2E builds enable the preview and
  // revalidation test controls; deployed previews compile them to 404s.
  env: { VINEXT_E2E_CONTROLS: process.env.VINEXT_E2E_CONTROLS === "1" ? "1" : "" },
  // Like Next.js, this replaces the asset layer's default for the file.
  async headers() {
    return [
      { source: "/visible.txt", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
    ];
  },
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/before/:path*", destination: "/:path*" },
        // The headerless build request takes this rewrite; signed-in visitors do not.
        { source: "/account", missing: [{ type: "cookie", key: "session" }], destination: "/" },
        // Same, but the build request resolves to an API route instead of a page.
        {
          source: "/billing",
          missing: [{ type: "cookie", key: "session" }],
          destination: "/api/viewer",
        },
      ],
      afterFiles: [{ source: "/after/:path*", destination: "/:path*" }],
      fallback: [{ source: "/fallback/:path*", destination: "/:path*" }],
    };
  },
};
