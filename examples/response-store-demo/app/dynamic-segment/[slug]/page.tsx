import Link from "next/link";

// Without generateStaticParams, Next.js renders a dynamic-segment route per
// request even though it sets `revalidate`.
export const revalidate = 60;

export default async function DynamicSegmentPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const renderId = crypto.randomUUID();

  return (
    <main>
      <nav className="crumbs">
        <Link prefetch={false} href="/">&larr; Demo home</Link>
      </nav>
      <h1>
        <code>/dynamic-segment/{slug}</code>
      </h1>
      <p className="tagline">
        This dynamic-segment route sets <code>revalidate = 60</code> but has no{" "}
        <code>generateStaticParams</code>, so vinext renders it per request without consulting the
        configured response cache.
      </p>
      <div className="timestamp">
        <p>
          Render ID: <code data-testid="dynamic-segment-render-id">{renderId}</code>
        </p>
      </div>
    </main>
  );
}
