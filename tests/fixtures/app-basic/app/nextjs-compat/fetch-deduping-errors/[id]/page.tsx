/**
 * Fixture for app-fetch-deduping-errors test.
 * Ported from: test/e2e/app-dir/app-fetch-deduping-errors/app/[id]/page.tsx
 *
 * Tests that when a fetch request errors (e.g. connection refused),
 * the page still renders successfully because the error is caught.
 */

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    // This fetch will fail — no server on port 8111
    await fetch("http://localhost:8111/nonexistent", {
      cache: "force-cache",
    });
  } catch {
    // Error expected — should not prevent metadata generation
  }

  return {
    title: `Page ${id}`,
  };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    // This fetch will fail — no server on port 8111
    await fetch("http://localhost:8111/nonexistent", {
      cache: "force-cache",
    });
  } catch {
    // Error expected — should not prevent page rendering
  }

  return <div>Hello World {id}</div>;
}
