// Loaded only by the build.outDir test that sets `configFile` to this file.
// The hybrid Pages Router build replays this plugin's config hook, which must
// not move the Pages server bundle or empty the App Router output.
export default {
  plugins: [
    {
      name: "test:late-outdir",
      config: () => ({ build: { outDir: "late-out", emptyOutDir: true } }),
    },
  ],
};
