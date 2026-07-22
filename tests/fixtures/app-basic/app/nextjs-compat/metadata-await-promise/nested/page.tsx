import { setTimeout } from "node:timers/promises";

export default async function Page() {
  await setTimeout(50);
  return <div id="page-content">Content</div>;
}

async function getTitle() {
  return setTimeout(5000, "Async Title");
}

export async function generateMetadata() {
  return { title: await getTitle() };
}
