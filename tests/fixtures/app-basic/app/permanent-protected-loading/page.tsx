import { permanentRedirect } from "next/navigation";

// Same shape as protected-loading/page.tsx but uses permanentRedirect (308)
// instead of redirect (307). As in Next.js, the document streams as a 200
// with the digest and an immediate meta refresh.
export default async function PermanentProtectedLoadingPage() {
  permanentRedirect("/");
}
