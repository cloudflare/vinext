import Link from "next/link";

export default async function TargetPage({
  searchParams,
}: {
  searchParams: Promise<{ param?: string }>;
}) {
  const { param = "none" } = await searchParams;

  return (
    <div>
      <h1>Server Search Target Page</h1>
      <p id="server-search-param">Server search param value: {param}</p>
      <Link
        href="/search-params-shared-loading-state/target-page-server-search?param=test"
        id="server-search-param-link"
        prefetch={false}
      >
        Search with param
      </Link>
    </div>
  );
}
