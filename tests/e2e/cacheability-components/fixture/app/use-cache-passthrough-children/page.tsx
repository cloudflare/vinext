import { cookies } from "next/headers";
import { Suspense, type ReactNode } from "react";

// The session is read outside the cached wrapper, which only passes its
// children through. Like Next.js, children reach the cache as temporary
// references: a hit must render the current request's children, never the
// ones from the request that filled the entry.
const SECRETS: Record<string, string> = {
  alice: "ALICE_PRIVATE_SECRET",
  bob: "BOB_PRIVATE_SECRET",
};

// `partition` only keys the entry.
async function CachedWrapper({
  partition: _partition,
  children,
}: {
  partition: string;
  children: ReactNode;
}) {
  "use cache";
  // Unique per execution: a module counter could restart with a new isolate.
  const generated = crypto.randomUUID();
  return (
    <section id="wrapper">
      <span id="wrapper-generated">{generated}</span>
      {children}
    </section>
  );
}

async function Viewer({ searchParams }: { searchParams: Promise<{ partition?: string }> }) {
  // Each test sequence uses its own partition so it starts from an empty entry.
  const { partition = "" } = await searchParams;
  const session = (await cookies()).get("session")?.value;
  const viewer = session && SECRETS[session] ? session : "guest";
  return (
    <>
      <p id="viewer">{viewer}</p>
      <CachedWrapper partition={partition}>
        <p id="secret">{SECRETS[viewer] ?? "PUBLIC_GUEST"}</p>
      </CachedWrapper>
    </>
  );
}

export default function UseCachePassthroughChildrenPage({
  searchParams,
}: {
  searchParams: Promise<{ partition?: string }>;
}) {
  return (
    <main>
      <Suspense fallback={null}>
        <Viewer searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
