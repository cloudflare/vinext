import { SearchParamsLabel } from "../search-params-label";

export const dynamic = "error";

// The dynamic segment, with no generateStaticParams, keeps prerendering and
// static export away from this page, which always fails.
export default function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // React serializes a promise prop by reading its then().
  return <SearchParamsLabel searchParams={searchParams} />;
}
