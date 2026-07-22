import { RefreshPendingClient } from "./refresh-pending-client";

async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function RouterRefreshPendingPage() {
  // Keep the refresh RSC request in flight long enough for the browser test to
  // observe the transition's pending state before the refreshed tree commits.
  await delay(1_000);

  return (
    <div>
      <h1 id="router-refresh-pending-title">Router refresh pending</h1>
      <RefreshPendingClient />
      <p id="refresh-server-stamp">server stamp: {Date.now()}</p>
    </div>
  );
}
