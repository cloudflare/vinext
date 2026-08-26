import type { NextConfig } from "vinext";

export default {
  headers() {
    return [
      {
        source: "/cache-probe/config-cache",
        headers: [{ key: "Cache-Control", value: "s-maxage=60" }],
      },
    ];
  },
} satisfies NextConfig;
