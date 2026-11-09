import Link from "next/link";

export const dynamic = "force-dynamic";

// Ported from Next.js navigation.test.ts "navigating to a page with async
// metadata". The page renders long before its metadata resolves.
export async function generateMetadata() {
  await new Promise((resolve) => setTimeout(resolve, 4000));
  return { title: "Async Title" };
}

export default async function Page({ searchParams }: { searchParams: Promise<{ v?: string }> }) {
  const { v = "1" } = await searchParams;
  await new Promise((resolve) => setTimeout(resolve, 50));
  return (
    <>
      <div id="page-content">Content</div>
      <p id="version">{v}</p>
      <Link href="/nextjs-compat/nav-async-metadata/nested?v=2">Version 2</Link>
    </>
  );
}
