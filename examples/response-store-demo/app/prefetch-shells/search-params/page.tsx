import Link from "next/link";

// Static, with no loading.tsx anywhere in its tree.
export default function PrefetchShellTargetPage() {
  const renderId = crypto.randomUUID();

  return (
    <main>
      <nav className="crumbs">
        <Link prefetch={false} href="/prefetch-shells">&larr; Prefetch shells</Link>
      </nav>
      <h1>
        <code>/prefetch-shells/search-params</code>
      </h1>
      <div className="timestamp">
        <p>
          Render ID: <code data-testid="render-id">{renderId}</code>
        </p>
      </div>
    </main>
  );
}
