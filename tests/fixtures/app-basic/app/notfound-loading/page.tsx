import { notFound } from "next/navigation";

// Async page wrapped by route-level loading.tsx that throws notFound(). The
// loading boundary catches it, so, as in Next.js, the document streams as a
// 200 with the digest, which the client's not-found boundary renders.
export default async function NotFoundLoadingPage() {
  notFound();
}
