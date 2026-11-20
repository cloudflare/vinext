import Buttons from "./buttons";

export const dynamic = "force-dynamic";

export default function ActionRedirectAfterRefresh() {
  return (
    <div>
      <h1>Action Redirect After Refresh</h1>
      <p data-testid="rendered-at">{Date.now()}</p>
      <Buttons />
    </div>
  );
}
