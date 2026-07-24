import { ParallelRefreshButton } from "../../../parallel-refresh/refresh-button";

export default function ParallelRefreshDynamicOtherPage() {
  return (
    <main data-testid="parallel-refresh-dynamic-other-page">
      <p data-testid="parallel-refresh-dynamic-other-token">{Math.random()}</p>
      <ParallelRefreshButton />
    </main>
  );
}
