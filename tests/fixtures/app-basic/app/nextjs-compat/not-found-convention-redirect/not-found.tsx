import { redirect } from "next/navigation";

// Next.js's error shell renders this metadata with no outlet, so the redirect
// is dropped and the page still answers 404.
export async function generateMetadata() {
  redirect("/");
}

export default function NotFound() {
  return <p id="convention-redirect-not-found">Convention redirect not found boundary</p>;
}
