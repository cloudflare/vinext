// A page whose "use cache" component and metadata functions are re-exported
// from another module is still a page segment function in Next.js, which marks
// the invocation with `$$isPage` (create-component-tree.tsx, resolve-metadata.ts).
export { default, generateMetadata, generateViewport } from "./cached-page";

export function generateStaticParams() {
  return [{ slug: "prerendered" }];
}
