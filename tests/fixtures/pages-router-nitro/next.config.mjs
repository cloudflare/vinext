export default {
  async rewrites() {
    return [{ source: "/rewrite-to-public", destination: "/hello.txt" }];
  },
};
