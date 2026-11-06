"use client";

// Ported from Next.js: test/e2e/app-dir/dynamic/app/default-loading/page.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/dynamic/app/default-loading/page.js
// Modified: 200 ms loader delay instead of 1000 ms, and reuses ../default's
// component instead of a copy with the dev-only isDevTest throw.
import dynamic from "next/dynamic";

const DynamicHeader = dynamic(
  () => {
    return new Promise<typeof import("../default/dynamic-component")>((resolve) => {
      setTimeout(() => {
        resolve(import("../default/dynamic-component"));
      }, 200);
    });
  },
  {
    loading: () => <p>Loading...</p>,
  },
);

const Page = () => {
  return (
    <div>
      <DynamicHeader />
    </div>
  );
};

export default Page;
