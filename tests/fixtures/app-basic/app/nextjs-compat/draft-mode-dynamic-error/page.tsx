import { draftMode } from "next/headers";

export const dynamic = "error";

export default async function DraftModeDynamicErrorPage() {
  let draftModeError = "missing";

  try {
    const draft = await draftMode();
    draftModeError = `unexpected:${draft.isEnabled}`;
  } catch (error) {
    draftModeError = error instanceof Error ? error.message : String(error);
  }

  return (
    <main>
      <h1>Draft Mode Dynamic Error</h1>
      <p id="draft-mode-error">{draftModeError}</p>
    </main>
  );
}
