import { redirect } from "next/navigation";

// The App Router phase writes no 404.html for a not-found page that
// redirects, so the build keeps the Pages Router's 404 page, unlike Next.js's
// static export, which writes the App Router's redirect shell.
export default function NotFound() {
  redirect("/");
}
