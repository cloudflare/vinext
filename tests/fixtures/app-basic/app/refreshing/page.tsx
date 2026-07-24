import Link from "next/link";
import { SearchParamsControl } from "../parallel-revalidation-controls";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ random?: string }>;
}) {
  const { random } = await searchParams;
  return (
    <main>
      <Link href="/refreshing/login">Open refreshing login</Link>
      <p data-testid="refreshing-page-token">{Math.random()}</p>
      <SearchParamsControl id="refreshing-page" random={random} />
    </main>
  );
}
