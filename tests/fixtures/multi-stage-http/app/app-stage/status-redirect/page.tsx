import { redirect } from "next/navigation";

// Reached through a middleware rewrite that sets status 404. The page's
// redirect() owns the response status, as in Next.js.
export default function StatusRedirectPage() {
  redirect("/app-stage/redirected");
}
