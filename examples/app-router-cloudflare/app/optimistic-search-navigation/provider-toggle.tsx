"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useLayoutEffect, useOptimistic, useRef, useTransition } from "react";

const providers = [
  { name: "netflix", value: "8" },
  { name: "prime", value: "9" },
  { name: "disney", value: "337" },
] as const;

function nextProviderQuery(currentQuery: string, provider: string) {
  const params = new URLSearchParams(currentQuery);

  if (params.get("provider") === provider) {
    params.delete("provider");
  } else {
    params.set("provider", provider);
  }

  return params.toString();
}

export function ProviderToggle() {
  const pathname = usePathname();
  const router = useRouter();
  const routeSearchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [optimisticQuery, setOptimisticQuery] = useOptimistic(
    routeSearchParams.toString(),
    (_currentQuery, nextQuery: string) => nextQuery,
  );
  const optimisticQueryRef = useRef(optimisticQuery);

  useLayoutEffect(() => {
    optimisticQueryRef.current = optimisticQuery;
  }, [optimisticQuery]);

  const toggleProvider = useCallback(
    (provider: string) => {
      const query = nextProviderQuery(optimisticQueryRef.current, provider);

      startTransition(() => {
        setOptimisticQuery(query);
        router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
      });
    },
    [pathname, router, setOptimisticQuery],
  );

  const selectedProvider = new URLSearchParams(optimisticQuery).get("provider");

  return (
    <section aria-labelledby="optimistic-provider-heading">
      <h2 id="optimistic-provider-heading">Optimistic provider filter</h2>
      <div role="group" aria-label="Streaming provider">
        {providers.map((provider) => (
          <button
            aria-pressed={selectedProvider === provider.value}
            data-testid={`provider-${provider.name}`}
            key={provider.value}
            onClick={() => toggleProvider(provider.value)}
            type="button"
          >
            {provider.name}
          </button>
        ))}
      </div>
      <dl>
        <dt>Client provider</dt>
        <dd data-testid="client-provider">{selectedProvider ?? "none"}</dd>
        <dt>Navigation pending</dt>
        <dd data-testid="navigation-pending">{String(isPending)}</dd>
      </dl>
    </section>
  );
}

export function RouterOnlyControl() {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <section aria-labelledby="router-control-heading">
      <h2 id="router-control-heading">Router-only control</h2>
      <button
        data-testid="router-only-control"
        onClick={() => router.push(`${pathname}?provider=control`, { scroll: false })}
        type="button"
      >
        Select control provider
      </button>
    </section>
  );
}
