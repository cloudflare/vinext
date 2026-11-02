// The asset URLs the bootstrap tags name carry the basePath, a path
// assetPrefix and (on CSS) the deployment id: the hashes are keyed by them.
export default {
  basePath: "/base",
  assetPrefix: "/cdn",
  deploymentId: "sri-deployment",
  experimental: {
    sri: { algorithm: "sha384" },
  },
};
