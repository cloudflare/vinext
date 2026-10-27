import { cache } from "react";

// Ported from Next.js: test/e2e/app-dir/use-cache/app/(partially-static)/react-cache/page.tsx
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-cache/app/(partially-static)/react-cache/page.tsx
const number = cache(() => Math.random());

function Component() {
  // Rendered while the cache entry is serialized, so React.cache dedupes it
  // with the call in the cached function's body.
  return <p id="b">{number()}</p>;
}

async function getCachedComponent() {
  "use cache";
  return (
    <div>
      <p id="a">{number()}</p>
      <Component />
    </div>
  );
}

export default async function Page() {
  return <div>{getCachedComponent()}</div>;
}
