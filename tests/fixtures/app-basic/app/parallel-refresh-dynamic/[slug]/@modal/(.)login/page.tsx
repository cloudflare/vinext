import { ParallelRefreshButton } from "../../../../parallel-refresh/refresh-button";

export default async function ParallelRefreshDynamicLoginModal({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ source?: string }>;
}) {
  const [{ slug }, { source }] = await Promise.all([params, searchParams]);
  return (
    <dialog data-testid="parallel-refresh-dynamic-login-modal" open>
      <p data-testid="parallel-refresh-dynamic-modal-slug">{slug}</p>
      <p data-testid="parallel-refresh-dynamic-modal-search">{source ?? "missing"}</p>
      <p data-testid="parallel-refresh-dynamic-modal-token">{Math.random()}</p>
      <ParallelRefreshButton />
    </dialog>
  );
}
