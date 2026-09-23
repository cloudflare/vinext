import Link from "next/link";

export const dynamic = "force-dynamic";

export default function ForceDynamicPage() {
  const renderId = crypto.randomUUID();

  return (
    <main>
      <nav className="crumbs">
        <Link prefetch={false} href="/">&larr; Demo home</Link>
      </nav>
      <h1>
        <code>/force-dynamic</code>
      </h1>
      <p className="tagline">
        This route is known to be dynamic at build time, so vinext renders it without consulting
        the configured response cache.
      </p>
      <div className="timestamp">
        <p>
          Render ID: <code data-testid="force-dynamic-render-id">{renderId}</code>
        </p>
      </div>
    </main>
  );
}
