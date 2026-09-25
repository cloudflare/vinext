import Link from "next/link";
import { Suspense } from "react";
import { SearchValue } from "../search-value";

// useSearchParams() inside Suspense on a static page: as in Next.js, the
// server renders the fallback and the browser fills in the query, so one
// stored page serves every query.
export default function SearchParamsSuspensePage() {
  const renderId = crypto.randomUUID();

  return (
    <main>
      <nav className="crumbs">
        <Link prefetch={false} href="/">&larr; Demo home</Link>
      </nav>
      <h1>
        <code>/search-params/suspense</code>
      </h1>
      <p>
        Query:{" "}
        <Suspense fallback={<code data-testid="search-fallback">loading</code>}>
          <SearchValue />
        </Suspense>
      </p>
      <div className="timestamp">
        <p>
          Render ID: <code data-testid="search-suspense-render-id">{renderId}</code>
        </p>
      </div>
    </main>
  );
}
