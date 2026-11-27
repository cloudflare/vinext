import { permanentRedirect } from "next/navigation";

// Middleware answers this path with NextResponse.next({ status: 404 })
// (issue #4946). The route's permanentRedirect() must own the response status.
export default function MiddlewareStatusPermanentRedirectPage() {
  permanentRedirect("/about");
}
