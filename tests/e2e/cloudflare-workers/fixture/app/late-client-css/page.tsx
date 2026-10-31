import { LatePanel } from "./panel";

export const dynamic = "force-dynamic";

export default async function LateClientCssPage() {
  await new Promise((resolve) => setTimeout(resolve, 200));
  return <LatePanel />;
}
