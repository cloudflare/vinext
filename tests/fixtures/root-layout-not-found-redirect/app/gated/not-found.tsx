import { headers } from "next/headers";
import { redirect } from "next/navigation";

// generateMetadata runs during head resolution for this fallback boundary
// (before the component renders). A redirect() thrown here is tagged as a
// metadata-origin error, so its transport depends on the request: streaming
// document responses get a 200 meta-refresh, html-limited bots get a blocking
// 307. Used to prove the fallback path threads serveStreamingMetadata.
export async function generateMetadata() {
  const requestHeaders = await headers();
  if (requestHeaders.get("x-vinext-gated-metadata-redirect") === "1") {
    redirect("/result");
  }
  return { title: "Gated Not Found" };
}

// Route-level not-found boundary for /gated. It renders only during the
// not-found *fallback* (after the page calls notFound()), never during the
// matched-route layout probe — so an async redirect() here is caught by the
// RSC drain in renderAppPageBoundaryElementResponse, not the layout
// special-error path. Uses its own header so the root layout does not redirect
// during probing and short-circuit before the fallback renders.
export default async function GatedNotFound() {
  const requestHeaders = await headers();
  if (requestHeaders.get("x-vinext-gated-notfound-redirect") === "1") {
    redirect("/result");
  }

  return <h1 id="gated-not-found">Gated Not Found</h1>;
}
