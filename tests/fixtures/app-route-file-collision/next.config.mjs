// Function-form config that extends Next.js's default pageExtensions.
// Mirrors Next.js test/e2e/custom-page-extension/next.config.js.
export default (phase, { defaultConfig }) => ({
  pageExtensions: [...defaultConfig.pageExtensions, "md", "mdx"],
});
