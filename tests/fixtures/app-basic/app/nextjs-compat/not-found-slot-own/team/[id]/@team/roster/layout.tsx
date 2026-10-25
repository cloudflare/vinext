import { notFound } from "next/navigation";

export default async function RosterLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // This layout's own signal belongs to the slot root's not-found, since
  // roster/not-found.tsx sits inside this layout.
  if (id === "missing") notFound();
  return <div id="slot-own-roster-layout">{children}</div>;
}
