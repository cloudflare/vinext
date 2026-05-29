import Link from "next/link";
import { CacheStatusProbe } from "./components/cache-status-probe";

export const revalidate = 0;

export default function HomePage() {
  return (
    <main>
      <h1>Request-context cache demo</h1>
      <p className="tagline">
        vinext supports route-level caching through whatever cache the runtime exposes on{" "}
        <code>ctx.cache</code>. ISR responses carry <code>Cache-Control</code> and{" "}
        <code>Cache-Tag</code> headers, and <code>revalidateTag()</code> /{" "}
        <code>revalidatePath()</code> automatically fan out to <code>ctx.cache.purge(...)</code>{" "}
        alongside the inner <code>CacheHandler</code>. Deployed here on Cloudflare Workers (which{" "}
        <a href="https://developers.cloudflare.com/workers/cache/" target="_blank" rel="noreferrer">
          provides
        </a>{" "}
        a compatible <code>ctx.cache</code> when <code>cache.enabled: true</code>), but no
        Cloudflare-specific import is required.
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
            <span className="badge">Dynamic</span> Always-fresh
          </h3>
          <p>
            <code>force-dynamic</code> for comparison. The Worker runs on every request and the
            outer cache is bypassed.
          </p>
          <Link prefetch={false} href="/dynamic">Open /dynamic &rarr;</Link>
        </div>
      </section>
    </main>
  );
}
