import dynamic from "next/dynamic";

const ClientOnly = dynamic(() => import("../components/client-only-component"), {
  ssr: false,
  loading: () => <p data-testid="loading">Loading client component...</p>,
});

const ClientOnlyNoLoading = dynamic(() => import("../components/client-only-component"), {
  ssr: false,
});

export default function DynamicSsrFalsePage() {
  return (
    <div>
      <h1>Dynamic SSR False Test</h1>
      <div data-testid="with-loading">
        <ClientOnly />
      </div>
      <div data-testid="without-loading">
        <ClientOnlyNoLoading />
      </div>
    </div>
  );
}
