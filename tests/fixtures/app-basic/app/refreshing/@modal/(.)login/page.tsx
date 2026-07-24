import {
  RefreshControl,
  RevalidateControl,
  SearchParamsControl,
} from "../../../parallel-revalidation-controls";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ random?: string }>;
}) {
  const { random } = await searchParams;
  return (
    <dialog open data-testid="refreshing-login-modal">
      <p data-testid="refreshing-modal-token">{Math.random()}</p>
      <RefreshControl />
      <RevalidateControl />
      <SearchParamsControl id="refreshing-modal" random={random} />
    </dialog>
  );
}
