import Link from "next/link";

export const unstable_dynamicStaleTime = 30;
export const dynamic = "force-dynamic";

export default async function ClientCacheTarget({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <main>
      <Link href="/nextjs-compat/client-cache" prefetch={false} id="client-cache-back">
        Back to client cache home
      </Link>
      <div id="client-cache-id">{id}</div>
      <div id="client-cache-random">{Math.random()}</div>
    </main>
  );
}
