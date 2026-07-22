import { permanentRedirect } from "next/navigation";

// Same shape as protected-loading/page.tsx but uses permanentRedirect (308)
// instead of redirect (307). The status comes from the digest's statusCode
// field; this regression confirms resolveAppPageSpecialError honors it
// rather than coercing to a default.
export default async function PermanentProtectedLoadingPage() {
  permanentRedirect("/");
}
