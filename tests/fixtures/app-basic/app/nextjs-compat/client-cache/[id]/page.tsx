import Link from "next/link";

import { LinkAccordion } from "../components/link-accordion";

export const unstable_dynamicStaleTime = 30;
export const dynamic = "force-dynamic";

export default async function ClientCacheTarget({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <main>
      <LinkAccordion href="/nextjs-compat/client-cache">
        To client cache home with accordion
      </LinkAccordion>
      <Link href="/nextjs-compat/client-cache" prefetch={false} id="client-cache-back">
        Back to client cache home
      </Link>
      <div id="client-cache-id">{id}</div>
      <div id="client-cache-random">{Math.random()}</div>
      <Link
        href={`/nextjs-compat/client-cache/${id === "0" ? "1" : "0"}`}
        prefetch={false}
        id="client-cache-sibling"
      >
        To sibling
      </Link>
    </main>
  );
}
