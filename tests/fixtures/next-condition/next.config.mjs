export default {
  // tests/next-condition.test.ts builds this fixture with and without Cache
  // Components, like Next.js' __NEXT_CACHE_COMPONENTS test matrix.
  cacheComponents: process.env.VINEXT_TEST_CACHE_COMPONENTS === "true",
  serverExternalPackages: ["my-external-esm-package", "my-external-cjs-package"],
  experimental: {
    // With Cache Components, barrel imports from it are left to Vite.
    optimizePackageImports: ["my-barrel-package"],
  },
};
