export const dynamic = "force-dynamic";

export async function generateMetadata() {
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  return {
    title: "Delayed streaming metadata",
    description: "Metadata resolved after the document shell",
  };
}

export default function MetadataStreamingTimingPage() {
  return <main data-testid="metadata-streaming-shell">Streaming metadata shell</main>;
}
