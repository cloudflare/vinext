import Link from "next/link";
import { PrefetchLog } from "./prefetch-log";

export default function PrefetchShellsPage() {
  return (
    <main>
      <nav className="crumbs">
        <Link prefetch={false} href="/">&larr; Demo home</Link>
      </nav>
      <h1>Prefetch shells</h1>
      <p className="tagline">
        The links below prefetch two static pages that have no <code>loading.tsx</code>. The log
        records each prefetch response, with its cache status and size.
      </p>

      <section className="grid">
        <div className="card">
          <h3>
            <span className="badge">Loading shell</span> Full prefetch
          </h3>
          <p>
            <code>&lt;Link prefetch&gt;</code> fetches the page&apos;s loading shell alongside the
            full payload. With no loading boundary, the shell is just the route tree: no layout
            renders.
          </p>
          <Link data-testid="route-tree-link" href="/prefetch-shells/route-tree" prefetch>
            Open /prefetch-shells/route-tree &rarr;
          </Link>
        </div>

        <div className="card">
          <h3>
            <span className="badge">Search params</span> Automatic prefetch
          </h3>
          <p>
            A link with a query prefetches the page&apos;s search-param shell. It is served from
            the page&apos;s cached navigation entry, so every query shows the same render ID.
          </p>
          <Link data-testid="search-params-link-1" href="/prefetch-shells/search-params?tab=1">
            Open ?tab=1 &rarr;
          </Link>
          <Link data-testid="search-params-link-2" href="/prefetch-shells/search-params?tab=2">
            Open ?tab=2 &rarr;
          </Link>
        </div>
      </section>

      <PrefetchLog />
    </main>
  );
}
