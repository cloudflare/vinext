import { revalidatePath, unstable_cache } from "next/cache";
import { draftMode } from "next/headers";

const routePath = "/nextjs-compat/action-draft-cache";
const getCachedData = unstable_cache(
  async () => Math.random().toString(36).slice(2),
  ["nextjs-compat-action-draft-cache"],
);

export const dynamic = "error";

export default async function ActionDraftCachePage() {
  async function enableDraftMode() {
    "use server";
    (await draftMode()).enable();
    revalidatePath(routePath);
  }

  async function disableDraftMode() {
    "use server";
    (await draftMode()).disable();
    revalidatePath(routePath);
  }

  const draft = await draftMode();
  const cachedData = await getCachedData();

  return (
    <main>
      <h1>Action Draft Cache</h1>
      <p id="draft-mode-enabled">{draft.isEnabled.toString()}</p>
      <p id="cached-data">{cachedData}</p>
      <form action={enableDraftMode}>
        <button id="enable-draft" type="submit">
          Enable Draft Mode
        </button>
      </form>
      <form action={disableDraftMode}>
        <button id="disable-draft" type="submit">
          Disable Draft Mode
        </button>
      </form>
    </main>
  );
}
