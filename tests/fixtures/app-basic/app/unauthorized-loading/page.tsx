import { unauthorized } from "next/navigation";

// Async page wrapped by route-level loading.tsx that throws unauthorized() (401).
// Exercises the post-shell digest swap path for NEXT_HTTP_ERROR_FALLBACK;401
// — verifies the status code from the digest is preserved (not coerced to 404)
// and the root unauthorized.tsx boundary is rendered.
export default async function UnauthorizedLoadingPage() {
  unauthorized();
}
