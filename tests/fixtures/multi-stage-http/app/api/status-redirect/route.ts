import { redirect } from "next/navigation";

// Reached through a middleware rewrite that sets status 404. The handler's
// redirect() owns the response status, as in Next.js.
export function GET() {
  redirect("/app-stage/redirected");
}
