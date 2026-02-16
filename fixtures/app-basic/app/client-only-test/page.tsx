import ClientOnlyWidget from "../components/client-only-widget";

export default function ClientOnlyTestPage() {
  return (
    <div>
      <h1 data-testid="client-only-heading">Client Only Test</h1>
      <ClientOnlyWidget />
    </div>
  );
}
