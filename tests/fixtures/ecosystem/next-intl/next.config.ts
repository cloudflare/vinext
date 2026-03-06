import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Simulates what next-intl's createNextIntlPlugin / withNextIntl does:
 * it registers a webpack.resolve.alias mapping "next-intl/config" to the
 * user's i18n/request.ts file. We can't use createNextIntlPlugin directly
 * because it tries to detect the Next.js version (which isn't installed in
 * vinext projects). This config exercises vinext's extractWebpackAliases
 * just like the real plugin would.
 */
export default {
  webpack: (config: any) => {
    if (!config.resolve) config.resolve = {};
    if (!config.resolve.alias) config.resolve.alias = {};
    config.resolve.alias["next-intl/config"] = path.resolve(
      __dirname,
      "i18n/request.ts",
    );
    return config;
  },
};
