import React from "react";
import dynamic from "next/dynamic";

// dynamic() without a loading option and a slow loader (issue #3718).
const SlowDynamicContent = dynamic(
  () =>
    new Promise<typeof import("../components/slow-dynamic-content")>((resolve) => {
      setTimeout(() => resolve(import("../components/slow-dynamic-content")), 300);
    }),
);

export default function DynamicNoLoadingPage() {
  return (
    <div>
      <h1 id="dynamic-no-loading-title">Dynamic Without Loading</h1>
      <SlowDynamicContent label="Loaded without loading option" />
    </div>
  );
}
