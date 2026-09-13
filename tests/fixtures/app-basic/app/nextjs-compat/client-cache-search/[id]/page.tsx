import Link from "next/link";

export default async function ClientCacheSearchTarget({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ timeout?: string }>;
}) {
  const [{ id }, { timeout }] = await Promise.all([params, searchParams]);
  await new Promise((resolve) => setTimeout(resolve, Number.parseInt(timeout ?? "0", 10)));

  return (
    <main>
      <Link href="/nextjs-compat/client-cache-search">Back to client cache search home</Link>
      <div id="client-cache-search-id">{id}</div>
      <div id="client-cache-search-random">{Math.random()}</div>
    </main>
  );
}
