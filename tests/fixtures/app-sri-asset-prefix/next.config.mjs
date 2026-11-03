// The asset URLs the bootstrap tags name carry the basePath, which also
// becomes the asset prefix, and (on CSS) the deployment id: the hashes are
// keyed by them.
export default {
  basePath: "/base",
  deploymentId: "sri-deployment",
  experimental: {
    sri: { algorithm: "sha384" },
  },
};
