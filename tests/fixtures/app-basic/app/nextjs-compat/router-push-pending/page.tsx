import { Suspense } from "react";
import { PendingClient } from "./pending-client";

async function SlowFilterResult({ filter }: { filter: string }) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));

  return <p id="server-filter">server filter: {filter}</p>;
}

export default async function RouterPushPendingPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter = "none" } = await searchParams;

  return (
    <div>
      <h1 id="router-push-pending-title">Router push pending</h1>
      <PendingClient />
      <Suspense fallback={<p id="server-filter-loading">loading</p>}>
        <SlowFilterResult filter={filter} />
      </Suspense>
    </div>
  );
}
