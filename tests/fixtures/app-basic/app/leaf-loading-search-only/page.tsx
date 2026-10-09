import Link from "next/link";
import { connection } from "next/server";

export default async function LeafLoadingSearchOnlyPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await connection();
  const { q = "none" } = await searchParams;
  await new Promise((resolve) => setTimeout(resolve, 3000));

  return (
    <>
      <h1 id={`leaf-loading-search-only-${q}`}>Search {q}</h1>
      <Link href="/leaf-loading-search-only" id="leaf-loading-search-only-clear-link">
        Clear search
      </Link>
    </>
  );
}
