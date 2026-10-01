import { connection } from "next/server";

// No Suspense boundary: the client receives the response, then holds the
// navigation uncommitted until this content streams in.
async function SlowContent() {
  await new Promise((resolve) => setTimeout(resolve, 4000));
  return <p id="slow-commit-content">Loaded</p>;
}

export default async function RefreshDuringNavigationSlowCommitPage() {
  // Dynamic, so each request renders it. With no Suspense boundary, a build's
  // speculative prerender still waits out the delay before skipping the page.
  // `dynamic = "force-dynamic"` would avoid that wait, but vinext then holds
  // the RSC response until the render finishes, which closes the accepted,
  // uncommitted window this page exists for.
  await connection();
  return (
    <>
      <h1 id="slow-commit-page">Slow commit</h1>
      <SlowContent />
    </>
  );
}
