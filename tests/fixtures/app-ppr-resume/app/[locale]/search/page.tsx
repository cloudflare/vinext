import { Suspense } from "react";
import { ClientQuery } from "./client-query";

async function Query({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  return <p id="query">query {q ?? "none"}</p>;
}

// Holes that read the query, so every query string shares the shell.
export default function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  return (
    <main>
      <h1 id="title">Search</h1>
      <Suspense fallback={<p id="query-loading">Loading query…</p>}>
        <Query searchParams={searchParams} />
      </Suspense>
      <Suspense fallback={<p id="client-query-loading">Loading client query…</p>}>
        <ClientQuery />
      </Suspense>
    </main>
  );
}
