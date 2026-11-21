export const dynamic = "force-dynamic";

export async function generateMetadata() {
  // Tests expect the metadata to land 600ms+ after the shell. The extra delay
  // leaves room for slow shell renders on a busy CI runner.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  return {
    title: "Delayed streaming metadata",
    description: "Metadata resolved after the document shell",
  };
}

export default function MetadataStreamingTimingPage() {
  return <main data-testid="metadata-streaming-shell">Streaming metadata shell</main>;
}
