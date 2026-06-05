import Link from "next/link";
import { CacheStatusProbe } from "../components/cache-status-probe";

// Comparison page: force-dynamic. The Worker runs on every request. vinext
// emits `Cache-Control: private, no-cache, no-store, ...` so the outer
// Workers Cache layer must not cache the response.
export const dynamic = "force-dynamic";

export default function DynamicPage() {
  const renderedAt = new Date().toISOString();
  const renderId = crypto.randomUUID();
  return (
    <main>
      <nav className="crumbs">
        <Link prefetch={false} href="/">&larr; Demo home</Link>
      </nav>
      <h1>
        <code>/dynamic</code>
      </h1>
      <p className="tagline">
        Bypass case for comparison. <code>force-dynamic</code> means vinext emits{" "}
        <code>no-store</code> headers, so neither the outer <code>ctx.cache</code> nor the
        inner CacheHandler retains anything. The timestamp updates on every reload — every
        probe should produce a fresh <code>render-id</code>.
      </p>
      <div
        className="timestamp"
        data-testid="rendered-at"
        data-render-id={renderId}
        data-render-time={renderedAt}
      >
        {renderedAt}
      </div>
      <p>
        Render ID: <code>{renderId}</code>
      </p>
      <CacheStatusProbe path="/dynamic" />
    </main>
  );
}
