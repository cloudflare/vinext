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
      <Link href="/nextjs-compat/client-cache/default-stale/1" id="client-cache-default-stale-auto">
        Auto prefetch with the default stale time
      </Link>
      <Link href="/nextjs-compat/client-cache/2" prefetch={false} id="client-cache-none">
        No prefetch
      </Link>
      <Link href="/nextjs-compat/client-cache/no-loading/1" id="client-cache-no-loading-auto">
        Auto prefetch without loading
      </Link>
      <Link href="/nextjs-compat/client-cache-full-render/1" id="client-cache-full-render-auto">
        Auto prefetch of a dynamic page without loading or parallel slots
      </Link>
      <Link
        href="/nextjs-compat/client-cache-runtime-dynamic"
        id="client-cache-runtime-dynamic-auto"
      >
        Auto prefetch of a page that renders dynamically at runtime
      </Link>
      <Link href="/nextjs-compat/client-cache-static-param/1" id="client-cache-static-param-auto">
        Auto prefetch of a statically generated dynamic page
      </Link>
      <Link
        href="/nextjs-compat/client-cache-late-dynamic"
        prefetch={true}
        id="client-cache-late-dynamic"
      >
        Full prefetch that becomes dynamic during streaming
      </Link>
      <ClientCacheControls />
    </main>
  );
}
