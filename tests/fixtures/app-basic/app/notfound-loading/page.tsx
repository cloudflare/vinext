import { notFound } from "next/navigation";

// Async page wrapped by route-level loading.tsx that throws notFound().
// Exercises the post-shell digest swap path for the bare NEXT_NOT_FOUND
// digest (distinct from NEXT_HTTP_ERROR_FALLBACK;404 — they take separate
// branches in resolveAppPageSpecialError). This is the most common
// loading-boundary special-error case in real apps: a dynamic detail
// page with a loading state that calls notFound() when the record is
// missing.
export default async function NotFoundLoadingPage() {
  notFound();
}
