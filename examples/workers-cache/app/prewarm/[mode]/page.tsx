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
      <PrewarmControls mode={mode} />
    </main>
  );
}
