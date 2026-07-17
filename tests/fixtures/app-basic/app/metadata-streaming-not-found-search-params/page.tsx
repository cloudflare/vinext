import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  await new Promise((resolve) => setTimeout(resolve, 100));
  notFound();
}

export default function MetadataStreamingNotFoundSearchParamsPage() {
  return <main>Streamed metadata not-found search params shell</main>;
}
