"use client";

// Ported from Next.js: test/e2e/app-dir/dynamic/app/default/page.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/dynamic/app/default/page.js
// Modified: 200 ms loader delay instead of 1000 ms.
import dynamic from "next/dynamic";

const DynamicHeader = dynamic(() => {
  return new Promise<typeof import("./dynamic-component")>((resolve) => {
    setTimeout(() => {
      resolve(import("./dynamic-component"));
    }, 200);
  });
});

const Page = () => {
  return (
    <div>
      <DynamicHeader />
    </div>
  );
};

export default Page;
