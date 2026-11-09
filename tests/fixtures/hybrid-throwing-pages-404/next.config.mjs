// A rewrite reaches another page for `/404`, so only a direct render reaches
// the Pages Router's 404 page.
export default {
  async rewrites() {
    return { beforeFiles: [{ source: "/404", destination: "/pages-home" }] };
  },
};
