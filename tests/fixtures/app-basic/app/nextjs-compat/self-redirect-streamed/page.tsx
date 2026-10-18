import { redirect } from "next/navigation";

// Redirects to itself after the loading.tsx shell has streamed.
export default async function Page() {
  await new Promise((resolve) => setTimeout(resolve, 50));
  redirect("/nextjs-compat/self-redirect-streamed");
}
