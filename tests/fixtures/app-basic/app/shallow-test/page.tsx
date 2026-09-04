"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Test page for shallow routing via history.pushState/replaceState.
 *
 * Uses window.history.pushState() and replaceState() directly
 * to update the URL without full navigation. Verifies that
 * usePathname() and useSearchParams() react to these changes.
 */
export default function ShallowTestPage() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  return (
    <main>
      <h1>Shallow Routing Test</h1>
      <p data-testid="pathname">pathname: {pathname}</p>
      <p data-testid="search">search: {searchParams.toString()}</p>

      <button
        data-testid="push-filter"
        onClick={() => {
          window.history.pushState(null, "", "/shallow-test?filter=active");
        }}
      >
        Push filter=active
      </button>

      <button data-testid="shallow-to-about" onClick={() => router.push("/about")}>
        Go to About
      </button>

      <button data-testid="shallow-to-home" onClick={() => router.push("/")}>
        Go to Home
      </button>

      <button data-testid="push-hash" onClick={() => router.push("#content")}>
        Push #content
      </button>

      <button
        data-testid="push-about-path"
        onClick={() => window.history.pushState(null, "", "/about")}
      >
        Push /about
      </button>

      <button
        data-testid="replace-sort"
        onClick={() => {
          window.history.replaceState(null, "", "/shallow-test?sort=name");
        }}
      >
        Replace sort=name
      </button>

      <button
        data-testid="push-path"
        onClick={() => {
          window.history.pushState(null, "", "/shallow-test/sub");
        }}
      >
        Push /shallow-test/sub
      </button>

      <button
        data-testid="push-combined"
        onClick={() => {
          window.history.pushState(null, "", "/shallow-test?a=1&b=2");
        }}
      >
        Push combined params
      </button>

      <h2 id="content">Content</h2>
    </main>
  );
}
