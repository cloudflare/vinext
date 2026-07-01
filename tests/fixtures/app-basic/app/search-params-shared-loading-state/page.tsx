import { LinkAccordion } from "./link-accordion";

export default function SearchParamsSharedLoadingStatePage() {
  return (
    <div>
      <p>
        This page tests whether a prefetched URL without search params can share its loading state
        with a navigation to the same URL with search params.
      </p>

      <ul>
        <li>
          <LinkAccordion href="/search-params-shared-loading-state/target-page" prefetch>
            Prefetch target (no search params)
          </LinkAccordion>
        </li>
        <li>
          <LinkAccordion href="/search-params-shared-loading-state/target-page?param=test" prefetch>
            Prefetch target (with search params)
          </LinkAccordion>
        </li>
        <li>
          <LinkAccordion
            href="/search-params-shared-loading-state/target-page-server-search"
            prefetch
          >
            Prefetch server-search target (no search params)
          </LinkAccordion>
        </li>
        <li>
          <LinkAccordion
            href="/search-params-shared-loading-state/target-page-server-search?param=test"
            prefetch
          >
            Prefetch server-search target (with search params)
          </LinkAccordion>
        </li>
      </ul>
    </div>
  );
}
