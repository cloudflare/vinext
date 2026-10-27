/**
 * Test fixture: layout whose own component renders fine, but a server
 * component it renders calls notFound() for invalid ids. The boundary above
 * the layout catches it, like a signal the layout itself throws.
 */
import { notFound } from "next/navigation";

async function IdGuard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id !== "hello") {
    notFound();
  }
  return <p id="not-found-layout-segment-guard-ok">Guard passed: {id}</p>;
}

export default function Layout({
  params,
  children,
}: {
  params: Promise<{ id: string }>;
  children: React.ReactNode;
}) {
  return (
    <section id="not-found-layout-segment-guard">
      <IdGuard params={params} />
      {children}
    </section>
  );
}
