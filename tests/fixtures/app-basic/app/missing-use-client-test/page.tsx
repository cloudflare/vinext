/**
 * Reproduces https://github.com/cloudflare/vinext/issues/834
 *
 * This is a SERVER component (no "use client" directive) that calls
 * usePathname() from next/navigation. It should throw a clear error
 * telling the developer to add "use client", but previously it
 * silently returned a fallback value.
 */
import { usePathname } from "next/navigation";

export default function MissingUseClientPage() {
  // This should throw an error because we're in a server component
  const pathname = usePathname();

  return (
    <div>
      <h1>Missing use client test</h1>
      <p>Pathname: {pathname}</p>
    </div>
  );
}
