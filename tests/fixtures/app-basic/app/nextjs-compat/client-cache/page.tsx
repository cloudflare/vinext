import Link from "next/link";
import { ClientCacheControls } from "./controls";
import { LinkAccordion } from "./components/link-accordion";

export default function ClientCacheHome() {
  return (
    <main>
      <LinkAccordion href="/nextjs-compat/client-cache/0" prefetch={true}>
        To dynamic page with accordion
      </LinkAccordion>
      <h1 id="client-cache-home">Client cache home</h1>
      <Link href="/nextjs-compat/client-cache/0" prefetch={true} id="client-cache-full">
        Full prefetch
      </Link>
      <Link href="/nextjs-compat/client-cache/1" id="client-cache-auto">
        Auto prefetch
      </Link>
      <Link href="/nextjs-compat/client-cache/2" prefetch={false} id="client-cache-none">
        No prefetch
      </Link>
      <Link href="/nextjs-compat/client-cache/no-loading/1" id="client-cache-no-loading-auto">
        Auto prefetch without loading
      </Link>
      <ClientCacheControls />
    </main>
  );
}
