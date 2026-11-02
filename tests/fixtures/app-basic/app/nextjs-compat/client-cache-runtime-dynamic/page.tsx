import { cookies } from "next/headers";

// No segment config: the build can't tell that this page renders dynamically.
export default async function ClientCacheRuntimeDynamicTarget() {
  await cookies();
  return <div id="client-cache-runtime-dynamic-random">{Math.random()}</div>;
}
