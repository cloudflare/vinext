import { RevealLink } from "./reveal-link";

// Links to one page with two query strings. Like Next.js's segment cache
// search-params test, the second appears only once asked for.
export default function SearchPrefetchLinks() {
  return (
    <main>
      <RevealLink id="a" />
      <RevealLink id="b" />
    </main>
  );
}
