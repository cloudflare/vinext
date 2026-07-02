type SearchParams = { foo?: string };

// Ported from Next.js: test/e2e/app-dir/segment-cache/vary-params/app/(main)/search-params/target-page/page.tsx
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/vary-params/app/(main)/search-params/target-page/page.tsx
export default async function SearchParamsTargetPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { foo } = await searchParams;

  return (
    <div id="segment-cache-vary-search-params-target-page">
      <div data-search-params-content="true">
        {`Search params target - foo: ${foo ?? "undefined"}`}
      </div>
    </div>
  );
}
