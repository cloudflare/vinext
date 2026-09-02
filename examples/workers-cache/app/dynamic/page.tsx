import Link from "next/link";
import { cookies } from "next/headers";
import { Suspense } from "react";
import { CacheStatusProbe } from "../components/cache-status-probe";

export const revalidate = 60;

async function LateDynamicViewer() {
  // Ensure the response stream exists before the request-bound API is read.
  // This reproduces the unsafe timing where public CDN headers could be exposed
  // before a late dynamic read marks the completed render private.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const viewer = (await cookies()).get("session")?.value ?? "anonymous";
  const renderedAt = new Date().toISOString();
  const renderId = crypto.randomUUID();

  return (
    <div
      className="timestamp"
      data-testid="late-dynamic-viewer"
      data-late-dynamic-viewer={viewer}
      data-late-dynamic-render-id={renderId}
      data-render-id={renderId}
      data-render-time={renderedAt}
    >
      <p>
        Viewer: <code>{viewer}</code>
      </p>
      <p>
        Render ID: <code>{renderId}</code>
      </p>
      <p>Rendered at: {renderedAt}</p>
    </div>
  );
}

export default function DynamicPage() {
  return (
    <main>
      <nav className="crumbs">
        <Link prefetch={false} href="/">&larr; Demo home</Link>
      </nav>
      <h1>
        <code>/dynamic</code>
      </h1>
      <p className="tagline">
        Bypass case for comparison. This page reads <code>cookies()</code> from a delayed
        Suspense boundary, after streaming starts. The completed render is dynamic, so neither
        the outer <code>ctx.cache</code> nor the inner CacheHandler may retain its personalized
        HTML.
      </p>
      <Suspense fallback={<p data-testid="late-dynamic-fallback">Resolving viewer…</p>}>
        <LateDynamicViewer />
      </Suspense>
      <CacheStatusProbe path="/dynamic" />
    </main>
  );
}
