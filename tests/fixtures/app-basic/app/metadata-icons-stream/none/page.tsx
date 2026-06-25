import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { title: "No icon" };
}

export default function NoIconPage() {
  return <h1 id="metadata-icons-page">No icon page</h1>;
}
