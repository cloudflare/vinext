import { redirect } from "next/navigation";

// An ISR page whose redirect() its loading.tsx catches. The shell renders, so
// Next.js streams and stores the document as a 200 with the digest and a meta
// refresh.
export const revalidate = 60;

export default async function Page() {
  redirect("/nextjs-compat/nav-redirect-result");
}
