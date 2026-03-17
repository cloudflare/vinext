import type { NextConfig } from "vinext";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      {
        source: "/config-redirect-itms-apps-slashes",
        destination: "itms-apps://apps.apple.com/de/app/xcode/id497799835?l=en-GB&mt=12",
        permanent: true,
      },
      {
        source: "/config-redirect-itms-apps-no-slashes",
        destination: "itms-apps:apps.apple.com/de/app/xcode/id497799835?l=en-GB&mt=12",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
