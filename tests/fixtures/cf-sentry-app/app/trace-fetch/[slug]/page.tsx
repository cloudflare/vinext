export const dynamic = "force-dynamic";

export default async function TraceFetchPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const response = await fetch("https://example.com/", { cache: "no-store" });
  return (
    <main>
      Traced fetch for {slug}: {response.status}
    </main>
  );
}
