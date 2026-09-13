import { Suspense } from "react";
import { headers } from "next/headers";

import { ProviderToggle, RouterOnlyControl } from "./provider-toggle";

export const dynamic = "force-dynamic";

export default async function OptimisticSearchNavigationPage({
  searchParams,
}: {
  searchParams: Promise<{ provider?: string }>;
}) {
  const provider = (await searchParams).provider ?? null;
  const requestedResultCount = Number(
    (await headers()).get("x-vinext-e2e-provider-result-count"),
  );
  const resultCount = requestedResultCount === 1_000 ? requestedResultCount : 3;

  return (
    <main>
      <h1>Optimistic search navigation</h1>
      <p>
        This reproduces a provider filter that optimistically updates before a same-path search
        parameter navigation commits.
      </p>
      <ProviderToggle />
      <RouterOnlyControl />
      <Suspense fallback={<p data-testid="provider-results-loading">Loading results…</p>}>
        <ProviderResults
          key={`${provider ?? "all"}:${resultCount}`}
          provider={provider}
          resultCount={resultCount}
        />
      </Suspense>
    </main>
  );
}

async function ProviderResults({
  provider,
  resultCount,
}: {
  provider: string | null;
  resultCount: number;
}) {
  // The reported route streams its filter shell before a slower provider-specific
  // list. Keep that production timing characteristic in this self-contained fixture.
  await new Promise((resolve) => setTimeout(resolve, provider ? 600 : 50));

  const listPrefix = provider ?? "all";

  return (
    <section data-testid="provider-results">
      <dl>
        <dt>Server provider</dt>
        <dd data-testid="server-provider">{provider ?? "none"}</dd>
      </dl>
      <ol>
        {Array.from({ length: resultCount }, (_, index) => (
          <li key={index}>
            {listPrefix} provider result {index + 1}
          </li>
        ))}
      </ol>
    </section>
  );
}
