import { Suspense } from "react";
import { VtBoundary } from "../vt-boundary";
import { SearchNav } from "./search-nav";

// Streams its result after the shell, so a navigation's response ends after
// its first commit.
async function SlowResult({ q }: { q: string }) {
  await new Promise((resolve) => setTimeout(resolve, 800));
  return <p data-testid="vt-search-result">result {q}</p>;
}

export default async function ViewTransitionTypesSearch({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = "" } = await searchParams;
  return (
    <VtBoundary name="search">
      <h1 data-testid="vt-search">search {q}</h1>
      <SearchNav />
      <Suspense key={q} fallback={<p data-testid="vt-search-loading">loading result</p>}>
        <SlowResult q={q} />
      </Suspense>
    </VtBoundary>
  );
}
