import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function ClientCacheNoLoadingTarget({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <main>
      <Link href="/nextjs-compat/client-cache" prefetch={false} id="client-cache-no-loading-back">
        Back to client cache home
      </Link>
      <div id="client-cache-no-loading-id">{id}</div>
      <div id="client-cache-no-loading-random">{Math.random()}</div>
    </main>
  );
}
