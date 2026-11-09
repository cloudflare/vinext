import { notFound } from "next/navigation";

export default async function InterceptedPlayer({ params }: { params: Promise<{ pid: string }> }) {
  const { pid } = await params;
  // Caught by roster/not-found.tsx, inside roster/layout.tsx, which wraps the
  // intercepting route below its marker.
  if (pid === "missing") notFound();
  return <p id="slot-own-roster-player">Player {pid}</p>;
}
