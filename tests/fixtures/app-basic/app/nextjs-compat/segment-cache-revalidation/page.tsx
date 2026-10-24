import { revalidatePath, updateTag } from "next/cache";
import { LinkAccordion } from "../client-cache/components/link-accordion";
import { ManualPrefetchLinkAccordion } from "./manual-prefetch-link-accordion";

// Ported from Next.js:
// test/e2e/app-dir/segment-cache/revalidation/app/page.tsx
export default function SegmentCacheRevalidationPage() {
  return (
    <>
      <form>
        <button
          id="revalidate-by-path"
          formAction={async function () {
            "use server";
            revalidatePath("/nextjs-compat/segment-cache-revalidation/greeting");
          }}
        >
          Revalidate by path
        </button>
        <button
          id="revalidate-by-tag"
          formAction={async function () {
            "use server";
            updateTag("random-greeting");
          }}
        >
          Revalidate by tag
        </button>
      </form>
      <ul>
        <li>
          <LinkAccordion href="/nextjs-compat/segment-cache-revalidation/greeting">
            Link to target page with prefetching enabled
          </LinkAccordion>
        </li>
        <li>
          <ManualPrefetchLinkAccordion href="/nextjs-compat/segment-cache-revalidation/greeting">
            Manual link (router.prefetch) to target page with prefetching enabled
          </ManualPrefetchLinkAccordion>
        </li>
      </ul>
    </>
  );
}
