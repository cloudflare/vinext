import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function DefaultStaleClientCacheTarget({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <main>
      <Link href="/nextjs-compat/client-cache" prefetch={false}>
        Back to client cache home
      </Link>
      <div>Default-stale client cache target {id}</div>
    </main>
  );
}
