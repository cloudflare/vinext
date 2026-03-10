"use client";
import { useSearchParams, usePathname } from "next/navigation";
export default function Page() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  return (
    <div>
      <h1 id="search-test-page">Search Params Test</h1>
      <p id="current-pathname">{pathname}</p>
      <p id="param-q">{searchParams.get("q") ?? "N/A"}</p>
      <p id="param-page">{searchParams.get("page") ?? "N/A"}</p>
      <p id="search-string">{searchParams.toString()}</p>
      <button
        id="push-search"
        onClick={() => {
          window.history.pushState(null, "", "/nextjs-compat/hooks-search?q=updated&page=2");
        }}
      >
        Update Search
      </button>
    </div>
  );
}
