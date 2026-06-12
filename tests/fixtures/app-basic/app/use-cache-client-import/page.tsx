import { ClientCacheCaller } from "./form";

export default function Page() {
  return (
    <main data-testid="use-cache-client-import-page">
      <h1>Client Imported Cache</h1>
      <ClientCacheCaller />
    </main>
  );
}
