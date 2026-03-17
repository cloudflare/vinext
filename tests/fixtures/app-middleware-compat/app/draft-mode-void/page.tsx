import { draftMode } from "next/headers";

export default async function DraftModeVoidPage() {
  const { isEnabled } = await draftMode();
  return (
    <>
      <p>draft-mode-void</p>
      <p id="draft-enabled">{String(isEnabled)}</p>
    </>
  );
}
