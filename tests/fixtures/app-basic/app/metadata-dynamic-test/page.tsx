export async function generateMetadata() {
  // Simulate async metadata generation (e.g., fetching from CMS)
  return {
    title: "Dynamic Metadata Page",
    description: "Generated dynamically via generateMetadata",
    alternates: {
      canonical: "https://example.com/metadata-dynamic-test",
      languages: { "en-US": "https://example.com/en/metadata-dynamic-test" },
    },
    robots: { index: false, follow: false },
    openGraph: {
      title: "Dynamic OG Title",
      description: "Dynamic OG Description",
      type: "article",
    },
  };
}

export default function DynamicMetadataPage() {
  return (
    <main>
      <h1 data-testid="dynamic-metadata-heading">Dynamic Metadata Test</h1>
      <p>This page uses generateMetadata for dynamic metadata.</p>
    </main>
  );
}
