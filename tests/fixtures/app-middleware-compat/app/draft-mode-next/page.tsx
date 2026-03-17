import { draftMode } from "next/headers";

export default async function DraftModeNextPage() {
  const { isEnabled } = await draftMode();
  return (
    <>
      <p>draft-mode-next</p>
      <p id="draft-enabled">{String(isEnabled)}</p>
    </>
  );
}
