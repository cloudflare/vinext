export default {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=3600" },
          { key: "CDN-Cache-Control", value: "public, max-age=3600" },
          { key: "Cloudflare-CDN-Cache-Control", value: "public, max-age=3600" },
          { key: "Cache-Tag", value: "action-process-config" },
          { key: "X-Action-Config-Headers", value: "present" },
        ],
      },
    ];
  },
};
