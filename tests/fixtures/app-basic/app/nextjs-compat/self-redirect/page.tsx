import { redirect } from "next/navigation";

// Redirects to itself: the client must not refetch it forever.
export default function Page() {
  redirect("/nextjs-compat/self-redirect");
}
