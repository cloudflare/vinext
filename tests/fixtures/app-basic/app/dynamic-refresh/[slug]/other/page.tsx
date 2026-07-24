import { RefreshControl, RevalidateControl } from "../../../parallel-revalidation-controls";

export default function Page() {
  return (
    <main>
      <p data-testid="dynamic-refresh-other-token">{Math.random()}</p>
      <RefreshControl />
      <RevalidateControl />
    </main>
  );
}
