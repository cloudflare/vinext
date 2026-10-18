import { redirect } from "next/navigation";

export default async function SlowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  if (id === "redirect") redirect("/nextjs-compat/optimistic-shell-shallow/slow/3");
  return <h1 id={`slow-${id}-page`}>Slow page {id}</h1>;
}
