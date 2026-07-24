import { ParallelRefreshButton } from "../../refresh-button";

export default function ParallelRefreshLoginModal() {
  return (
    <dialog data-testid="parallel-refresh-login-modal" open>
      <p data-testid="parallel-refresh-modal-token">{Math.random()}</p>
      <ParallelRefreshButton />
    </dialog>
  );
}
