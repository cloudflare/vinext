export default function ParallelRefreshMultipleModal() {
  return (
    <dialog data-testid="parallel-refresh-multiple-modal" open>
      <p data-testid="parallel-refresh-multiple-modal-token">{Math.random()}</p>
    </dialog>
  );
}
