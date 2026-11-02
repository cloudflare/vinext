import Link from "next/link";
import { EffectProbe } from "../../effect-probe";

export default async function ChatLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <section>
      <EffectProbe name={`room-layout:${id}`} />
      <Link href={`/bfcache-effects/chat/${id}`}>Room {id}</Link>
      <Link href={`/bfcache-effects/chat/${id}/info`}>Room {id} info</Link>
      {children}
    </section>
  );
}

export function generateStaticParams() {
  return ["a", "b", "c", "d", "e"].map((id) => ({ id }));
}
