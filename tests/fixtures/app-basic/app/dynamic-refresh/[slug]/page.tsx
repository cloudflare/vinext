import Link from "next/link";
import { SearchParamsControl } from "../../parallel-revalidation-controls";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ random?: string }>;
}) {
  const [{ slug }, { random }] = await Promise.all([params, searchParams]);
  return (
    <main>
      <Link href={`/dynamic-refresh/${slug}/login`}>Open dynamic refreshing login</Link>
      <p data-testid="dynamic-refresh-page-token">{Math.random()}</p>
      <SearchParamsControl id="dynamic-refresh-page" random={random} />
    </main>
  );
}
