import { redirect } from "next/navigation";

// Async work before the redirect ensures the page promise is still pending
// when the probe phase runs. Without the fix, the probe's
// `awaitAsyncResult: !hasLoadingBoundary` short-circuit swallows the
// rejection (loading.tsx is present), the RSC stream re-runs the page,
// the redirect throws under the route-level Suspense boundary, and the
// response becomes 200 with a serialized "Switched to client rendering"
// error instead of a clean 307.
export default async function ProtectedLoadingPage() {
  await new Promise((r) => setTimeout(r, 10));
  redirect("/");
}
