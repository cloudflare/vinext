import { draftMode } from "next/headers";

export const dynamic = "error";

export default async function DraftModeDynamicErrorPage() {
  let draftModeStatus = "missing";

  try {
    const draft = await draftMode();
    draftModeStatus = `enabled:${draft.isEnabled}`;
  } catch (error) {
    draftModeStatus = error instanceof Error ? error.message : String(error);
  }

  return (
    <main>
      <h1>Draft Mode Dynamic Error</h1>
      <p id="draft-mode-status">{draftModeStatus}</p>
    </main>
  );
}
