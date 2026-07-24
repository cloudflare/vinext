import {
  RefreshControl,
  RevalidateControl,
  SearchParamsControl,
} from "../../../../parallel-revalidation-controls";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ random?: string }>;
}) {
  const [{ slug }, { random }] = await Promise.all([params, searchParams]);
  return (
    <dialog open data-testid="dynamic-refresh-login-modal">
      <p data-testid="dynamic-refresh-modal-slug">{slug}</p>
      <p data-testid="dynamic-refresh-modal-token">{Math.random()}</p>
      <RefreshControl />
      <RevalidateControl />
      <SearchParamsControl id="dynamic-refresh-modal" random={random} />
    </dialog>
  );
}
