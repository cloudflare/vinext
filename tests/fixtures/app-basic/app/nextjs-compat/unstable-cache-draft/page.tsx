import { unstable_cache } from "next/cache";
import { draftMode } from "next/headers";

const getCachedData = unstable_cache(
  async () => Math.random().toString(36).slice(2),
  ["nextjs-compat-unstable-cache-draft"],
);

export const dynamic = "force-dynamic";

export default async function Page() {
  const data = await getCachedData();
  const draft = await draftMode();

  return (
    <main>
      <p id="cached-data">{data}</p>
      <p id="draft-mode-enabled">{draft.isEnabled.toString()}</p>
    </main>
  );
}
