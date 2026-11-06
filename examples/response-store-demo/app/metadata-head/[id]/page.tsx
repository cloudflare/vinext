export const revalidate = 1;

export async function generateStaticParams() {
  return [];
}

// Streamed metadata lands in <head> only when the document is rendered whole.
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { title: `Metadata head ${id}` };
}

export default async function MetadataHeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <p>
      metadata head {id} <span data-testid="timestamp">{Date.now()}</span>
    </p>
  );
}
