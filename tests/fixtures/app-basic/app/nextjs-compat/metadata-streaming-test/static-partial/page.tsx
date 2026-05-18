// Ported from Next.js: test/e2e/app-dir/metadata-streaming/app/static/partial/page.tsx
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-streaming/app/static/partial/page.tsx
//
// A "partial static" page: the page body renders quickly, but generateMetadata
// resolves asynchronously. Even though the rest of the page is static, the
// metadata is dynamic and so should stream into <body>, not be emitted directly
// into <head>.
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
