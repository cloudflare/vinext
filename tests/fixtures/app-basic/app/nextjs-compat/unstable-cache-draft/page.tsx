import { unstable_cache } from "next/cache";
import { draftMode } from "next/headers";

const getCachedData = unstable_cache(
  async (key: string) => {
    const draft = await draftMode();
    return {
      data: `${key}-${Math.random().toString(36).slice(2)}`,
      draftMode: draft.isEnabled,
    };
  },
  ["nextjs-compat-unstable-cache-draft"],
);

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ key?: string }> }) {
  const { key = "default" } = await searchParams;
  const cached = await getCachedData(key);

  return (
    <main>
      <p id="cached-data">{cached.data}</p>
      <p id="draft-mode-enabled">{cached.draftMode.toString()}</p>
    </main>
  );
}
