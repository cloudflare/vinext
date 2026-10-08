import { unauthorized } from "next/navigation";

// Async page wrapped by route-level loading.tsx that throws unauthorized()
// (401). The loading boundary catches it, so, as in Next.js, the document
// streams as a 200 with the digest, which the client's unauthorized boundary
// renders.
export default async function UnauthorizedLoadingPage() {
  unauthorized();
}
