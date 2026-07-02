import { LinkAccordion } from "../link-accordion";

// Ported from Next.js: test/e2e/app-dir/segment-cache/vary-params/app/(main)/search-params/page.tsx
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/vary-params/app/(main)/search-params/page.tsx
export default function SearchParamsIndexPage() {
  return (
    <div id="segment-cache-vary-search-params-index">
      <h1>Segment Cache Vary Params</h1>
      <ul>
        <li>
          <LinkAccordion href="/nextjs-compat/segment-cache-vary-params/search-params/static-target?foo=1">
            Static target with foo=1
          </LinkAccordion>
        </li>
        <li>
          <LinkAccordion href="/nextjs-compat/segment-cache-vary-params/search-params/static-target?foo=2">
            Static target with foo=2
          </LinkAccordion>
        </li>
        <li>
          <LinkAccordion href="/nextjs-compat/segment-cache-vary-params/search-params/target-page?foo=1">
            Target with foo=1
          </LinkAccordion>
        </li>
        <li>
          <LinkAccordion href="/nextjs-compat/segment-cache-vary-params/search-params/target-page?foo=2">
            Target with foo=2
          </LinkAccordion>
        </li>
      </ul>
    </div>
  );
}
