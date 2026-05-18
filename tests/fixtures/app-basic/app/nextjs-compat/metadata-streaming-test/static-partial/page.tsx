// Ported from upstream `test/e2e/app-dir/metadata-streaming/app/static/partial/page.tsx`;
// vinext flattens to `static-partial/` because the shared `app-basic` fixture
// keeps nextjs-compat tests at a single nesting level instead of the upstream
// `static/<variant>/` hierarchy.
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-streaming/app/static/partial/page.tsx
//
// A "partial static" page: the page body renders quickly, but generateMetadata
// resolves asynchronously. Even though the rest of the page is static, the
// metadata is dynamic and so should stream into <body>, not be emitted directly
// into <head>.
//
// Intentionally omits `export const dynamic = "force-dynamic"` (unlike the
// sibling slow/ and index fixtures). The point is to exercise the partial-
// static case where the page itself is statically renderable but metadata
// streams in late.
export default function Page() {
  return <div>inner static page</div>;
}

export async function generateMetadata() {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return {
    title: "partial static page",
    description: "partial static page description",
  };
}
