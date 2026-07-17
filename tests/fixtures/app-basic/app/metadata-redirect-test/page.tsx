import { redirect } from "next/navigation";

// generateMetadata throws redirect(). In Next.js, streaming-capable document
// requests stay HTTP 200 and receive a refresh meta tag, html-limited bots get
// a blocking 307, and RSC navigation requests receive the redirect in the
// flight payload.
export async function generateMetadata() {
  await new Promise((resolve) => setTimeout(resolve, 100));
  redirect("/about");
}

export default function MetadataRedirectTestPage() {
  return <div data-testid="metadata-redirect-page">metadata redirect page</div>;
}
