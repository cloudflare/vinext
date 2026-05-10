import { redirect } from "next/navigation";

export default async function DelayedProtectedLoadingPage() {
  await new Promise((resolve) => setTimeout(resolve, 50));
  redirect("/about");
}
