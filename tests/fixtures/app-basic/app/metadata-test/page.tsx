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
  themeColor: {
    color: "#0070f3",
    media: "(prefers-color-scheme: light)",
  },
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-visual",
};

export default function MetadataTestPage() {
  return (
    <main>
      <h1>Metadata Test</h1>
      <p>This page has static metadata.</p>
    </main>
  );
}
