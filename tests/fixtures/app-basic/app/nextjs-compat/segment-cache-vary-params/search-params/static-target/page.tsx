// Ported from Next.js: test/e2e/app-dir/segment-cache/vary-params/app/(main)/search-params/static-target/page.tsx
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/vary-params/app/(main)/search-params/static-target/page.tsx
export default function StaticTargetPage() {
  return (
    <div id="segment-cache-vary-static-target-page">
      <div data-static-target-content="true">Static target content - no searchParams access</div>
    </div>
  );
}
