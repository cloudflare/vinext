import { cache } from "react";
import type { Metadata } from "next";

// Ported from Next.js: test/e2e/app-dir/metadata/app/cache-deduping/page.tsx
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/app/cache-deduping/page.tsx
// The fetch() half of that fixture is omitted: these tests run offline.
const getRandomMemoized = cache(() => Math.random().toString());

export default function Page() {
  const val = getRandomMemoized();
  return <p id="value">{val}</p>;
}

export async function generateMetadata(): Promise<Metadata> {
  const val = getRandomMemoized();
  return {
    title: {
      default: JSON.stringify({ page: "cache-deduping", val }),
    },
  };
}
