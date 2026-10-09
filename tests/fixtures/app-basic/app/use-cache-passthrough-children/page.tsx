import { cookies } from "next/headers";
import type { ReactNode } from "react";

// Used by Playwright: app-router-prod/use-cache.spec.ts. The session is read
// outside the cached wrapper, which only passes its children through. Like
// Next.js, children reach the cache as temporary references: a hit must render
// the current request's children, never the ones from the request that filled
// the entry.
const SECRETS: Record<string, string> = {
  alice: "ALICE_PRIVATE_SECRET",
  bob: "BOB_PRIVATE_SECRET",
};

async function CachedWrapper({ partition, children }: { partition: string; children: ReactNode }) {
  "use cache";
  return (
    <section id="wrapper">
      <span id="wrapper-generated">{Math.random()}</span>
      {children}
    </section>
  );
}

export default async function UseCachePassthroughChildrenPage({
  searchParams,
}: {
  searchParams: Promise<{ partition?: string }>;
}) {
  // Each test sequence uses its own partition so it starts from an empty entry.
  const { partition = "" } = await searchParams;
  const session = (await cookies()).get("session")?.value;
  const viewer = session && SECRETS[session] ? session : "guest";
  return (
    <main>
      <p id="viewer">{viewer}</p>
      <CachedWrapper partition={partition}>
        <p id="secret">{SECRETS[viewer] ?? "PUBLIC_GUEST"}</p>
      </CachedWrapper>
    </main>
  );
}
