import { Suspense } from "react";
import { notFound } from "next/navigation";

// The @team slot page's title wins over this one, as Turbopack orders a
// layout's children before its slots.
export const metadata = { title: "Team page" };

async function LateMain(): Promise<never> {
  await Promise.resolve();
  notFound();
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // With the @team slot's own signal: caught by team/[id]/not-found.tsx inside
  // the team layout, while the slot's own not-found catches the slot's.
  if (id === "both") notFound();
  if (id === "late") {
    // The same, from below a Suspense boundary, so only the slot's signal
    // rejects the document's shell.
    return (
      <Suspense fallback={<p id="slot-own-main-loading">Loading main</p>}>
        <LateMain />
      </Suspense>
    );
  }
  return <p id="slot-own-main">Main</p>;
}
