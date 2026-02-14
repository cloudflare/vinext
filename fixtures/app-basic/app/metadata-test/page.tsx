export const metadata = {
  title: "Metadata Test Page",
  description: "A page to test the metadata API",
  keywords: ["test", "metadata", "nextcompat"],
  openGraph: {
    title: "OG Title",
    description: "OG Description",
    type: "website",
  },
};

export default function MetadataTestPage() {
  return (
    <main>
      <h1>Metadata Test</h1>
      <p>This page has static metadata.</p>
    </main>
  );
}
