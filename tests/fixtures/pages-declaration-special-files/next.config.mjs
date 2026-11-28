// `d.ts` is an explicit page extension, but so is `ts`, so `_app.d.ts` and
// `_document.d.ts` are not the app's custom _app/_document (Next.js
// build/route-discovery.ts createPagesMapping).
export default {
  pageExtensions: ["ts", "d.ts"],
};
