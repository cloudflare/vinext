import Link from "next/link";
import { headers } from "next/headers";
import { Suspense } from "react";
import { SearchValue } from "../search-value";

// The page reads headers(), so it's rendered per request: useSearchParams()
// server-renders the real query and the page is never stored.
export default async function SearchParamsDynamicPage() {
  await headers();
  const renderId = crypto.randomUUID();

  return (
    <main>
      <nav className="crumbs">
        <Link prefetch={false} href="/">&larr; Demo home</Link>
      </nav>
      <h1>
        <code>/search-params/dynamic</code>
      </h1>
      <p>
        Query:{" "}
        <Suspense fallback={<code data-testid="search-fallback">loading</code>}>
          <SearchValue />
        </Suspense>
      </p>
      <div className="timestamp">
        <p>
          Render ID: <code data-testid="search-dynamic-render-id">{renderId}</code>
        </p>
      </div>
    </main>
  );
}
