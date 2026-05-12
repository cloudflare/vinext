import { redirect } from "next/navigation";

export default async function DelayedProtectedLoadingPage() {
  // 500ms gives Playwright enough time to observe the loading.tsx fallback
  // before the redirect fires, even on fast CI runners where 50ms was too
  // short and the redirect resolved before the fallback could paint.
  await new Promise((resolve) => setTimeout(resolve, 500));
  redirect("/about");
}
