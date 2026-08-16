export default {
  pageExtensions: ["js", "jsx", "ts", "tsx", "mdx"],
  serverExternalPackages: ["app-esm-package1", "app-esm-package2", "app-cjs-esm-package"],
  transpilePackages: ["explicit-esm-package"],
  experimental: { optimizePackageImports: ["optimized-esm-package"] },
  turbopack: { resolveAlias: { "preact/compat": "react" } },
  webpack(config) {
    config.resolve.alias = { ...config.resolve.alias, "preact/compat": "react" };
    return config;
  },
};
