export default {
  async rewrites() {
    return [{ source: "/rewritten", destination: "/other" }];
  },
};
