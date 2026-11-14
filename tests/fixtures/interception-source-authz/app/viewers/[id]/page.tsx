// Middleware admits only trusted viewers (see middleware.ts).
export default async function ViewerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p>SECRET-VIEWER-CONTENT {id}</p>;
}
