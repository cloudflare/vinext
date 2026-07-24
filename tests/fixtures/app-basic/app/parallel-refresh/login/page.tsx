import { ParallelRefreshButton } from "../refresh-button";

export default function ParallelRefreshLoginPage() {
  return (
    <main data-testid="parallel-refresh-login-page">
      <p data-testid="parallel-refresh-login-token">{Math.random()}</p>
      <ParallelRefreshButton />
    </main>
  );
}
