import { ParallelRefreshButton } from "../../parallel-refresh/refresh-button";

export default function ParallelRefreshMultipleOtherPage() {
  return (
    <main data-testid="parallel-refresh-multiple-other-page">
      <p data-testid="parallel-refresh-multiple-other-token">{Math.random()}</p>
      <ParallelRefreshButton />
    </main>
  );
}
