"use client";

import dynamic from "next/dynamic";

const DynamicNoSSR = dynamic(() => import("../text-dynamic-no-ssr-client"), { ssr: false });

export default function Page() {
  return (
    <div id="content">
      <p id="static-text">This is static content</p>
      <DynamicNoSSR name=":test" />
    </div>
  );
}
