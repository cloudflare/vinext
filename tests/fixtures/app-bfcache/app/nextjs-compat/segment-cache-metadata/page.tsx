import { LinkAccordion } from "./link-accordion";

const root = "/nextjs-compat/segment-cache-metadata";

export default function Page() {
  return (
    <>
      <ul>
        <li>
          <LinkAccordion prefetch={true} href={`${root}/page-with-dynamic-head`}>
            Page with dynamic head
          </LinkAccordion>
        </li>
        <li>
          <LinkAccordion prefetch={true} href={`${root}/rewrite-to-page-with-dynamic-head`}>
            Rewrite to page with dynamic head
          </LinkAccordion>
        </li>
      </ul>
      <ul>
        <li>
          <LinkAccordion prefetch={true} href={`${root}/page-with-runtime-prefetchable-head`}>
            Page with runtime-prefetchable head
          </LinkAccordion>
        </li>
        <li>
          <LinkAccordion
            prefetch={true}
            href={`${root}/rewrite-to-page-with-runtime-prefetchable-head`}
          >
            Rewrite to page with runtime-prefetchable head
          </LinkAccordion>
        </li>
      </ul>
    </>
  );
}
