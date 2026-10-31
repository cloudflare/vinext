import { IsrPanel } from "./panel";

export const revalidate = 60;

export default async function LateIsrPage() {
  await new Promise((resolve) => setTimeout(resolve, 200));
  return <IsrPanel />;
}
