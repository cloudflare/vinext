import { redirect } from "next/navigation";

// An ISR page whose redirect() its loading.tsx catches. The shell renders, so
// Next.js streams the document with the digest and a meta refresh, and its
// static generation stores it as a 307 with the location.
export const revalidate = 60;

export default async function Page() {
  redirect("/nextjs-compat/nav-redirect-result");
}
