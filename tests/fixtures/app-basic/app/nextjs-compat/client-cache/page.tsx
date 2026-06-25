import Link from "next/link";
import { ClientCacheControls } from "./controls";

export default function ClientCacheHome() {
  return (
    <main>
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
      <ClientCacheControls />
    </main>
  );
}
