import { unstable_cache } from "next/cache";
import { draftMode } from "next/headers";

const getCachedData = unstable_cache(
  async () => ({
    data: Math.random().toString(36).slice(2),
    draftMode: (await draftMode()).isEnabled,
  }),
  ["nextjs-compat-unstable-cache-draft-dynamic-error-page"],
);

export const dynamic = "error";

export default async function Page() {
  const cached = await getCachedData();

  return (
    <main>
      <p id="cached-data">{cached.data}</p>
      <p id="draft-mode-enabled">{cached.draftMode.toString()}</p>
    </main>
  );
}
