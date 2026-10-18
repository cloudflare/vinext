import { redirect } from "next/navigation";

// An ISR page whose redirect() rejects the shell. Next.js stores its render
// with status 307 and its location.
export const revalidate = 60;

export default function Page() {
  redirect("/nextjs-compat/nav-redirect-result");
}
