import { draftMode } from "next/headers";

export const revalidate = 300;

export default async function PrewarmTargetPage() {
  return (
    <main>
      <output data-testid="build-id">{process.env.__VINEXT_BUILD_ID}</output>
      <output data-testid="draft-mode">{String((await draftMode()).isEnabled)}</output>
      <h1>Prewarm target</h1>
    </main>
  );
}
