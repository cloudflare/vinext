import React from "react";
import Link from "next/link";

export default function DynamicNoLoadingLinkPage() {
  return (
    <div>
      <h1>Dynamic Without Loading Link</h1>
      <Link href="/dynamic-no-loading" id="to-dynamic-no-loading">
        Go to dynamic without loading
      </Link>
    </div>
  );
}
