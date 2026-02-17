export const metadata = {
  title: "Metadata Test Page",
  description: "A page to test the metadata API",
  keywords: ["test", "metadata", "vinext"],
  openGraph: {
    title: "OG Title",
    description: "OG Description",
    type: "website",
  },
};

export const viewport = {
  themeColor: "#0070f3",
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function MetadataTestPage() {
  return (
    <main>
      <h1>Metadata Test</h1>
      <p>This page has static metadata.</p>
    </main>
  );
}
