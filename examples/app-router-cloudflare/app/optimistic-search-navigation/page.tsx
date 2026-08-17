import { Suspense } from "react";

import { ProviderToggle, RouterOnlyControl } from "./provider-toggle";

export const dynamic = "force-dynamic";

export default async function OptimisticSearchNavigationPage({
  searchParams,
}: {
  searchParams: Promise<{ provider?: string }>;
}) {
  const provider = (await searchParams).provider ?? null;

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
        <ProviderResults key={provider ?? "all"} provider={provider} />
      </Suspense>
    </main>
  );
}

async function ProviderResults({ provider }: { provider: string | null }) {
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
        {Array.from({ length: 3 }, (_, index) => (
          <li key={index}>
            {listPrefix} provider result {index + 1}
          </li>
        ))}
      </ol>
    </section>
  );
}
