import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Suspense } from "react";

export async function generateMetadata(): Promise<Metadata> {
  await cookies();
  return {
    title: "Runtime-prefetchable title",
  };
}

async function Content() {
  await cookies();
  return <div id="target-page">Target page</div>;
}

export default function PageWithRuntimePrefetchableTitle() {
  return (
    <Suspense fallback="Loading...">
      <Content />
    </Suspense>
  );
}
