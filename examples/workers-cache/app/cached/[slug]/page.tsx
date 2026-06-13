import Link from "next/link";
import { CacheStatusProbe } from "../../components/cache-status-probe";
import { RevalidateControls } from "../../components/revalidate-controls";

// ISR config — slugs are cached for 60 seconds with a 5-minute
// stale-while-revalidate window. vinext emits this as
// `Cache-Control: s-maxage=60, stale-while-revalidate=240` and the Workers
// Cache layer honours it automatically.
export const revalidate = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return { title: `Cached page: ${slug}` };
}

/**
 * Pretend to load post data for `slug`. The `next: { tags }` option attaches
 * `post:<slug>` to the page's cache entry — that's the same propagation
 * Next.js does for tagged fetches in real apps. With the tag on the entry,
 * `revalidateTag("post:<slug>")` invalidates the page (in both the inner
 * CacheHandler and the outer Workers Cache via `Cache-Tag`).
 *
 * The fetch target is a no-op data: URL so the demo has no external
 * dependency — vinext's fetch shim records the tag before doing any I/O.
 */
async function loadPost(slug: string): Promise<{ title: string }> {
  const payload = JSON.stringify({ slug });
  await fetch(`data:application/json,${encodeURIComponent(payload)}`, {
    next: { tags: [`post:${slug}`], revalidate: 60 },
  });
  return { title: `Post: ${slug}` };
}

export default async function CachedSlugPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const path = `/cached/${slug}`;
  const tag = `post:${slug}`;
  const post = await loadPost(slug);

  // Generated at render time. Embedded into the response so the client probe
  // can tell whether a subsequent fetch was actually re-rendered (new id) or
  // served from cache (same id). This is the only honest source of truth for
  // "did SSR happen for that response" — outer cache headers describe what
  // the cache layer thinks, not what the React tree actually did.
  const renderedAt = new Date().toISOString();
  const renderId = crypto.randomUUID();
  const random = Math.random().toFixed(6);

  return (
    <main>
      <nav className="crumbs">
        <Link prefetch={false} href="/">&larr; Demo home</Link>
      </nav>
      <h1>{post.title}</h1>
      <p className="tagline">
        ISR-cached for <code>revalidate = 60</code>. A tagged fetch during render attaches{" "}
        <code>{tag}</code> to this page's cache entry — both the inner <code>CacheHandler</code>{" "}
        and the outer Workers Cache will honour <code>revalidateTag(&quot;{tag}&quot;)</code>.
      </p>

      <p>Server-side timestamp:</p>
      <div
        className="timestamp"
        data-testid="rendered-at"
        data-render-id={renderId}
        data-render-time={renderedAt}
      >
        {renderedAt}
      </div>
      <p>
        Render ID: <code data-render-id-tag>{renderId}</code>
      </p>
      <p>
        Sample noise (re-rendered = re-randomised): <code>{random}</code>
      </p>

      <CacheStatusProbe path={path} />
      <RevalidateControls tag={tag} path={path} />
    </main>
  );
}
