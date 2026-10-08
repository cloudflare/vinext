import { forbidden } from "next/navigation";

// Async page wrapped by route-level loading.tsx that throws forbidden() (403).
// The loading boundary catches it, so, as in Next.js, the document streams as
// a 200 with the digest, which the client's forbidden boundary renders.
export default async function ForbiddenLoadingPage() {
  forbidden();
}
