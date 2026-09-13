import { PrewarmControls } from "./controls";

export const dynamic = "force-dynamic";

export default async function PrewarmSourcePage({
  params,
}: {
  params: Promise<{ mode: string }>;
}) {
  const { mode } = await params;
  return (
    <main>
      <h1>RSC prewarm source: {mode}</h1>
      <output data-testid="build-id">{process.env.__VINEXT_BUILD_ID}</output>
      <PrewarmControls mode={mode} />
    </main>
  );
}
