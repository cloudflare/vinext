import type { NextConfig } from "vinext";

export default {
  headers() {
    return [
      {
        source: "/cache-probe/config-cache",
        headers: [{ key: "Cache-Control", value: "s-maxage=300" }],
      },
      {
        source: "/cache-probe/config-pages-ssr",
        headers: [{ key: "Cache-Control", value: "s-maxage=300" }],
      },
      {
        source: "/cache-probe/config-route",
        headers: [{ key: "Cache-Control", value: "s-maxage=300" }],
      },
    ];
  },
} satisfies NextConfig;
