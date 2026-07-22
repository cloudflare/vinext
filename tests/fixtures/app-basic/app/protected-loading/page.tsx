import { redirect } from "next/navigation";

// Async page that throws redirect() at the top of the body. The page
// returns a rejected promise which propagates through React's onError
// during shell render. Without the fix, the route-level Suspense
// boundary (loading.tsx) absorbs the throw and React serializes a
// "Switched to client rendering" error in the body instead of a 307.
//
// With the fix (skip probe + post-shell digest swap), the rscErrorTracker
// captures the digest from React's onError before the SSR shell promise
// resolves, and the lifecycle swaps the response to a clean 307.
export default async function ProtectedLoadingPage() {
  redirect("/");
}
