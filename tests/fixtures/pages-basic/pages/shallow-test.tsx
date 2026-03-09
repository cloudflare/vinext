import { useRouter } from "next/router";

interface ShallowTestProps {
  /** Increments every time GSSP runs — lets us detect re-fetches */
  gsspCallId: number;
  serverQuery: Record<string, string>;
}

// Track GSSP call count across requests (module-level state in dev server)
let gsspCallCount = 0;

export async function getServerSideProps(ctx: any) {
  gsspCallCount++;
  const serverQuery: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.query)) {
    serverQuery[k] = Array.isArray(v) ? v[0] : (v ?? "");
  }
  return {
    props: {
      gsspCallId: gsspCallCount,
      serverQuery,
    },
  };
}

export default function ShallowTestPage({ gsspCallId, serverQuery }: ShallowTestProps) {
  const router = useRouter();

  return (
    <div>
      <h1>Shallow Routing Test</h1>
      <p data-testid="gssp-call-id">gssp:{gsspCallId}</p>
      <p data-testid="router-query">{JSON.stringify(router.query)}</p>
      <p data-testid="server-query">{JSON.stringify(serverQuery)}</p>
      <p data-testid="router-pathname">{router.pathname}</p>
      <p data-testid="router-asPath">{router.asPath}</p>
      <button
        data-testid="shallow-push"
        onClick={() => router.push("/shallow-test?tab=settings", undefined, { shallow: true })}
      >
        Shallow Push
      </button>
      <button data-testid="deep-push" onClick={() => router.push("/shallow-test?tab=profile")}>
        Deep Push
      </button>
      <button
        data-testid="shallow-replace"
        onClick={() => router.replace("/shallow-test?view=grid", undefined, { shallow: true })}
      >
        Shallow Replace
      </button>
    </div>
  );
}
