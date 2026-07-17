export async function generateMetadata() {
  return { title: "Streamed not-found metadata" };
}

export async function generateViewport() {
  throw new Error("Fallback viewport must not run while resolving not-found metadata");
}

export default function MetadataStreamingNotFound() {
  return <main data-testid="metadata-streaming-not-found">Streamed metadata not found</main>;
}
