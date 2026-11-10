import { unstable_cache } from "next/cache";
import { draftMode } from "next/headers";
import { after } from "next/server";
import { Suspense } from "react";
import {
  markDraftLateCacheDone,
  waitForDraftLateCacheRelease,
} from "../../../lib/draft-late-cache-probe";

// A draft render that calls unstable_cache() after its response has been sent
// (a HEAD whose body was cancelled, or an after() callback) must still keep
// the draft result out of the shared cache. The draft flag is closed over, so
// the cache key is the same for draft and public requests.

export const dynamic = "force-dynamic";

function getEntry(id: string, isDraft: boolean) {
  return unstable_cache(
    async () => ({ draft: isDraft, value: Math.random().toString(36).slice(2) }),
    ["nextjs-compat-unstable-cache-draft-late", id],
  )();
}

async function LateEntry({ id, isDraft }: { id: string; isDraft: boolean }) {
  if (isDraft) await waitForDraftLateCacheRelease(id);
  const entry = await getEntry(id, isDraft);
  markDraftLateCacheDone(id);
  return (
    <>
      <p id="draft-mode-enabled">{String(entry.draft)}</p>
      <p id="cached-data">{entry.value}</p>
    </>
  );
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; phase?: string }>;
}) {
  const { id = "default", phase } = await searchParams;
  const { isEnabled } = await draftMode();

  if (phase === "after") {
    after(async () => {
      await getEntry(id, isEnabled);
      markDraftLateCacheDone(id);
    });
    return <p id="phase">after</p>;
  }

  return (
    <main>
      <Suspense fallback={<p>loading</p>}>
        <LateEntry id={id} isDraft={isEnabled} />
      </Suspense>
    </main>
  );
}
