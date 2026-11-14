/** @type {import('vinext').NextConfig} */
export default {
  output: "export",
  // Ported from Next.js: test/e2e/app-dir-export/test/trailing-slash.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir-export/test/trailing-slash.test.ts
  trailingSlash: true,
  // Used by E2E: static-export/images.spec.ts. Next.js's documented way to use
  // next/image with `output: "export"`; next/legacy/image ignores it.
  images: { loaderFile: "./image-loader.ts" },
};
