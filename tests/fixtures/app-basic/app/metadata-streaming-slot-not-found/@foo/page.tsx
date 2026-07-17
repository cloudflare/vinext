import { notFound } from "next/navigation";

export async function generateMetadata() {
  await new Promise((resolve) => setTimeout(resolve, 100));
  notFound();
}

export default function MetadataStreamingFooSlot() {
  return <p>Metadata streaming foo slot</p>;
}
