import { redirect } from "next/navigation";

// Reached through a middleware rewrite that sets status 404 (issue #4946).
// The route handler's redirect() must own the response status.
export function GET() {
  redirect("/about");
}
