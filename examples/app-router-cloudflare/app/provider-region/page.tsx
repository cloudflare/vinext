import { headers } from "next/headers";
import { Suspense } from "react";

import { ProviderFilter } from "./provider-filter";
import { getRequestRegion } from "./region";

export const dynamic = "force-dynamic";

export default async function ProviderRegionPage({
  searchParams,
}: {
  searchParams: Promise<{ provider?: string }>;
}) {
  const provider = (await searchParams).provider ?? null;
  const requestHeaders = await headers();
  const headerCountry = requestHeaders.get("cf-ipcountry");
  const resolvedCountry = getRequestRegion(requestHeaders);

  return (
    <main>
      <h1>Provider region propagation</h1>
      <p>
        This reproduces a region-specific provider filter that reads the visitor country only from
        cf-ipcountry and falls back to the US.
      </p>
      <dl>
        <dt>Page cf-ipcountry header</dt>
        <dd data-testid="page-header-country">{headerCountry ?? "missing"}</dd>
        <dt>Page resolved country</dt>
        <dd data-testid="page-resolved-country">{resolvedCountry}</dd>
      </dl>
      <ProviderFilter />
      <Suspense fallback={<p data-testid="provider-results-loading">Loading results…</p>}>
        <ProviderResults key={provider ?? "all"} provider={provider} region={resolvedCountry} />
      </Suspense>
    </main>
  );
}

async function ProviderResults({
  provider,
  region,
}: {
  provider: string | null;
  region: string;
}) {
  await new Promise((resolve) => setTimeout(resolve, provider ? 300 : 25));

  return (
    <section data-testid="provider-results">
      <h2>Server-filtered results</h2>
      <dl>
        <dt>Server provider</dt>
        <dd data-testid="server-provider">{provider ?? "none"}</dd>
        <dt>Server region</dt>
        <dd data-testid="server-region">{region}</dd>
      </dl>
    </section>
  );
}
