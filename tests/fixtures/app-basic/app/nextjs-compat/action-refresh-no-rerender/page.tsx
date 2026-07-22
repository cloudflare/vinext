import { ActionRefreshClient } from "./client";
import { getFlag } from "./state";

export const dynamic = "force-dynamic";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function Page() {
  const value = getFlag();
  await wait(1_000);

  return <ActionRefreshClient value={value} />;
}
