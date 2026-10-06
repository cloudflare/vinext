import Link from "next/link";
import { SearchValue } from "../../search-value";

// No path is generated at build, so each one renders on demand. With
// useSearchParams() outside Suspense, Next.js answers such a path with a 500
// (and fails `next build` for a generated one), and so does vinext in
// production.
export function generateStaticParams() {
  return [];
}

export default function SearchParamsUnwrappedPage() {
  return (
    <main>
      <nav className="crumbs">
        <Link prefetch={false} href="/">&larr; Demo home</Link>
      </nav>
      <h1>
        <code>/search-params/unwrapped/[slug]</code>
      </h1>
      <p>
        Query: <SearchValue />
      </p>
    </main>
  );
}
