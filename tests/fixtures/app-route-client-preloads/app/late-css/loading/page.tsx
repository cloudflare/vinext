import { LoadingPanel } from "./panel";

export const dynamic = "force-dynamic";

export default async function LateLoadingPage() {
  await new Promise((resolve) => setTimeout(resolve, 200));
  return <LoadingPanel />;
}
