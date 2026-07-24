import { RefreshControl } from "../../../parallel-revalidation-controls";

export default function Page() {
  return (
    <main>
      <p data-testid="dynamic-refresh-login-token">{Math.random()}</p>
      <RefreshControl />
    </main>
  );
}
