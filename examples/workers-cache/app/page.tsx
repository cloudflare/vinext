import Link from "next/link";
import { CacheStatusProbe } from "./components/cache-status-probe";

export const revalidate = 0;

export default function HomePage() {
  return (
    <main>
      <h1>Workers Response Store cache adapter</h1>
      <p className="tagline">
        vinext persists ISR and <code>&quot;use cache&quot;</code> values through Workers Response Store.
        The application Worker stays uncached; a service-bound cache Worker owns Workers Cache,
        R2 bodies, and SQLite Durable Object metadata.
      </p>

      <CacheStatusProbe path="/cached/intro" />

      <h2>Pick a demo route</h2>
      <section className="grid">
        <div className="card">
          <h3>
            <span className="badge">ISR</span> Static page
          </h3>
          <p>
            Renders a server timestamp under <code>revalidate = 60</code>. Every reload after the
            first should hit the cache layer.
          </p>
          <Link prefetch={false} href="/cached/intro">Open /cached/intro &rarr;</Link>
        </div>

        <div className="card">
          <h3>
            <span className="badge">Tags</span> Tagged content
          </h3>
          <p>
            A tagged <code>fetch()</code> during render attaches <code>post:&lt;slug&gt;</code> to
            the page's cache entry. Try <code>revalidateTag(&quot;post:featured&quot;)</code> from
            the panel.
          </p>
          <Link prefetch={false} href="/cached/featured">Open /cached/featured &rarr;</Link>
        </div>

        <div className="card">
          <h3>
            <span className="badge">Route</span> Cached route handler
          </h3>
          <p>
            <code>/api/now</code> caches a JSON payload for 30s. Watch the timestamp freeze, then
            refresh after the revalidate window.
          </p>
          <Link prefetch={false} href="/api/now">Open /api/now &rarr;</Link>
        </div>

        <div className="card">
          <h3>
            <span className="badge">Data</span> Use cache
          </h3>
          <p>
            A dynamic page runs for every request while a <code>&quot;use cache&quot;</code> function keeps
            the same UUID in the response store.
          </p>
          <Link prefetch={false} href="/use-cache">Open /use-cache &rarr;</Link>
        </div>

        <div className="card">
          <h3>
            <span className="badge">Dynamic</span> Always-fresh
          </h3>
          <p>
            A delayed <code>cookies()</code> read for comparison. The Worker completes the
            personalized stream privately on every request without writing an ISR entry.
          </p>
          <Link prefetch={false} href="/dynamic">Open /dynamic &rarr;</Link>
        </div>
      </section>
    </main>
  );
}
