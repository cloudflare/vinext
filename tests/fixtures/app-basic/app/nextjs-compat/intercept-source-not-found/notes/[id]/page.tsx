import Link from "next/link";
import { notFound } from "next/navigation";

export default async function NotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id === "missing") notFound();
  if (id === "slow") await new Promise((resolve) => setTimeout(resolve, 3000));
  return (
    <p id="intercept-source-not-found-note">
      Note: {id} <Link href="/nextjs-compat/intercept-source-not-found/notes/slow">Slow note</Link>
    </p>
  );
}
