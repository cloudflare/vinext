import { ParallelRefreshButton } from "../refresh-button";

export default function ParallelRefreshOtherPage() {
  return (
    <main data-testid="parallel-refresh-other-page">
      <p data-testid="parallel-refresh-other-token">{Math.random()}</p>
      <ParallelRefreshButton />
    </main>
  );
}
