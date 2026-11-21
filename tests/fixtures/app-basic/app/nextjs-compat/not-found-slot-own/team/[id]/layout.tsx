import { notFound } from "next/navigation";

export default async function Layout({
  children,
  params,
  team,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
  team: React.ReactNode;
}) {
  // With the @team slot's own signal: caught above this layout, so the
  // not-found above it renders, without this layout or the slot.
  if ((await params).id === "gone") notFound();
  return (
    <section id="slot-own-team-layout">
      {children}
      <div id="slot-own-team-slot">{team}</div>
    </section>
  );
}
