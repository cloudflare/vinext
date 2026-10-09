"use client";

// A slow dynamic() without a loading option under the route's loading.tsx. It
// has no Suspense boundary of its own, so it suspends to loading.tsx's
// boundary, whose fallback shows until the import resolves.
import dynamic from "next/dynamic";

const DynamicHeader = dynamic(() => {
  return new Promise<typeof import("../default/dynamic-component")>((resolve) => {
    setTimeout(() => {
      resolve(import("../default/dynamic-component"));
    }, 200);
  });
});

export default function Page() {
  return (
    <div>
      <DynamicHeader />
    </div>
  );
}
