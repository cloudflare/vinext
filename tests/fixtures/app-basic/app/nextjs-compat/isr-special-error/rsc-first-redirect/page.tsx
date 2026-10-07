import { redirect } from "next/navigation";

// An ISR page whose redirect() rejects the shell, first rendered by an RSC
// request. Next.js stores its RSC payload with status 307 and its location,
// and sends it as a 200.
export const revalidate = 60;

export default function Page() {
  redirect("/nextjs-compat/nav-redirect-result");
}
