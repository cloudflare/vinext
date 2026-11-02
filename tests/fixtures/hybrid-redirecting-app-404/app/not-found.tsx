import { redirect } from "next/navigation";

// The App Router phase writes no 404.html for a not-found page that
// redirects (`next build` exports its redirect shell), so the build keeps the
// Pages Router's 404 page.
export default function NotFound() {
  redirect("/");
}
