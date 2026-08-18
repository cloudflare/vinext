"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";

type Provider = {
  id: number;
  name: string;
};

type ProviderResponse = {
  cfCountry: string | null;
  headerCountry: string | null;
  resolvedCountry: string;
  providers: Provider[];
};

export function ProviderFilter() {
  const pathname = usePathname();
  const router = useRouter();
  const routeSearchParams = useSearchParams();
  const [providerData, setProviderData] = useState<ProviderResponse | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [optimisticQuery, setOptimisticQuery] = useOptimistic(
    routeSearchParams.toString(),
    (_currentQuery, nextQuery: string) => nextQuery,
  );
  const optimisticQueryRef = useRef(optimisticQuery);

  useLayoutEffect(() => {
    optimisticQueryRef.current = optimisticQuery;
  }, [optimisticQuery]);

  useEffect(() => {
    const controller = new AbortController();

    const loadProviders = async () => {
      try {
        const response = await fetch("/api/provider-region", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as ProviderResponse;
        if (!controller.signal.aborted) setProviderData(data);
      } catch (error: unknown) {
        if (controller.signal.aborted) return;
        setProviderError(error instanceof Error ? error.message : String(error));
      }
    };

    void loadProviders();

    return () => controller.abort();
  }, []);

  const toggleProvider = useCallback(
    (provider: string) => {
      const params = new URLSearchParams(optimisticQueryRef.current);
      if (params.get("provider") === provider) {
        params.delete("provider");
      } else {
        params.set("provider", provider);
      }
      const query = params.toString();

      startTransition(() => {
        setOptimisticQuery(query);
        router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
      });
    },
    [pathname, router, setOptimisticQuery],
  );

  const selectedProvider = new URLSearchParams(optimisticQuery).get("provider");

  return (
    <section aria-labelledby="provider-region-filter-heading">
      <h2 id="provider-region-filter-heading">Provider catalog returned to the client</h2>
      {providerData ? (
        <>
          <dl>
            <dt>Raw request.cf.country</dt>
            <dd data-testid="api-cf-country">{providerData.cfCountry ?? "missing"}</dd>
            <dt>API cf-ipcountry header</dt>
            <dd data-testid="api-header-country">{providerData.headerCountry ?? "missing"}</dd>
            <dt>API resolved country</dt>
            <dd data-testid="api-resolved-country">{providerData.resolvedCountry}</dd>
          </dl>
          <div role="radiogroup" aria-label="Streaming service">
            {providerData.providers.map((provider) => {
              const value = String(provider.id);
              const isActive = selectedProvider === value;
              return (
                <button
                  aria-checked={isActive}
                  data-testid={`provider-${provider.id}`}
                  key={provider.id}
                  onClick={() => toggleProvider(value)}
                  role="radio"
                  type="button"
                >
                  {provider.name}
                </button>
              );
            })}
          </div>
        </>
      ) : providerError ? (
        <p data-testid="providers-error">Provider request failed: {providerError}</p>
      ) : (
        <p data-testid="providers-loading">Loading providers…</p>
      )}
      <dl>
        <dt>Client provider</dt>
        <dd data-testid="client-provider">{selectedProvider ?? "none"}</dd>
        <dt>Navigation pending</dt>
        <dd data-testid="navigation-pending">{String(isPending)}</dd>
      </dl>
    </section>
  );
}
