import { redirect } from "next/navigation";

// Async page wrapped by route-level loading.tsx that throws redirect(). The
// loading boundary catches it, so, as in Next.js, the document streams as a
// 200 with the digest and a meta refresh, which the client follows.
export default async function ProtectedLoadingPage() {
  redirect("/");
}
