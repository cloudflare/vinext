export default {
  experimental: {
    globalNotFound: true,
  },
  async headers() {
    return [
      // A forwarded header-only action redirect already carries the owner's
      // config headers, so the source request must not apply its own on top
      // (duplicate Set-Cookie from a rule matching both paths, or a Flight
      // Content-Type restored onto the empty body). Gated on a probe header
      // so only that test opts in.
      {
        source: "/ownership/report/:path*",
        has: [{ type: "header", key: "x-action-config-header-probe" }],
        headers: [
          { key: "Set-Cookie", value: "action-config-cookie=1; Path=/" },
          { key: "Content-Type", value: "text/x-component" },
        ],
      },
    ];
  },
};
