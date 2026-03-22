import Link from "next/link";
import { Suspense } from "react";

async function ProviderList() {
  await new Promise((resolve) => setTimeout(resolve, 400));

  return (
    <ul id="provider-list">
      <li>
        <Link href="/nav-flash/provider/acme" id="provider-link">
          Acme Provider
        </Link>
      </li>
      <li>Globex Provider</li>
      <li>Initech Provider</li>
    </ul>
  );
}

export default function ProviderListPage() {
  return (
    <main>
      <h1 id="providers-title">Providers</h1>
      <div style={{ height: "2400px" }} />
      <Suspense fallback={<p id="providers-loading">Loading providers...</p>}>
        <ProviderList />
      </Suspense>
    </main>
  );
}
