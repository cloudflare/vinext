import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";

export async function generateMetadata(): Promise<Metadata> {
  await connection();
  return {
    title: "Dynamic Title",
  };
}

async function Content() {
  await connection();
  return <div id="target-page">Target page</div>;
}

export default function PageWithDynamicTitle() {
  return (
    <Suspense fallback="Loading...">
      <Content />
    </Suspense>
  );
}
