// `d.ts` is an explicit page extension, but so is `ts`, so declaration files
// are still not route files (Next.js createPagesMapping).
export default {
  pageExtensions: ["ts", "d.ts"],
};
