/**
 * Ported from Next.js:
 * test/e2e/next-image-new/loader-config-default-loader-with-file/next.config.js
 * https://github.com/vercel/next.js/blob/canary/test/e2e/next-image-new/loader-config-default-loader-with-file/next.config.js
 */
module.exports = {
  images: {
    loader: "default",
    loaderFile: "./image-loader.js",
  },
};
