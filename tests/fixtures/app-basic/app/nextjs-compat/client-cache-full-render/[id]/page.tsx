import Link from "next/link";

export const dynamic = "force-dynamic";

// A dynamic route with no loading boundary and no parallel slots: like Next.js,
// its automatic prefetch fetches only the route shell, never the page.
export default async function ClientCacheFullRenderTarget({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <main>
      <Link href="/nextjs-compat/client-cache" prefetch={false} id="client-cache-full-render-back">
        Back to client cache home
      </Link>
      <div id="client-cache-full-render-id">{id}</div>
      <div id="client-cache-full-render-random">{Math.random()}</div>
    </main>
  );
}
