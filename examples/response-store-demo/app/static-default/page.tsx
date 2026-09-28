import Link from "next/link";

// No revalidate export, fetch revalidate or cacheLife: Next.js defaults a
// static page to `revalidate = false` and serves it until it's revalidated.
export default function StaticDefaultPage() {
  const renderId = crypto.randomUUID();

  return (
    <main>
      <nav className="crumbs">
        <Link prefetch={false} href="/">&larr; Demo home</Link>
      </nav>
      <h1>
        <code>/static-default</code>
      </h1>
      <p className="tagline">
        This page has no revalidate source, so vinext stores it with <code>revalidate = false</code>{" "}
        and serves it until <code>revalidatePath</code>, <code>revalidateTag</code> or the next
        deploy.
      </p>
      <div className="timestamp">
        <p>
          Render ID: <code data-testid="static-default-render-id">{renderId}</code>
        </p>
      </div>
    </main>
  );
}
