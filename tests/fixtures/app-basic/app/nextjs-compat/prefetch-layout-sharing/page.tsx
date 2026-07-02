import { LinkAccordion } from "./link-accordion";

const ROOT = "/nextjs-compat/prefetch-layout-sharing";

export default function PrefetchLayoutSharingPage() {
  return (
    <main>
      <h1 id="prefetch-layout-sharing-home">Prefetch layout sharing home</h1>
      <LinkAccordion
        href={`${ROOT}/shared-layout/one`}
        id="prefetch-layout-sharing-one"
        prefetch={true}
      />
      <LinkAccordion
        href={`${ROOT}/shared-layout/two`}
        id="prefetch-layout-sharing-two"
        prefetch={true}
      />
      <LinkAccordion
        href={`${ROOT}/shared-layout/two`}
        id="prefetch-layout-sharing-two-auto"
        prefetch="auto"
      />
      <LinkAccordion
        href={`${ROOT}/dynamic-layout/a`}
        id="prefetch-layout-sharing-dynamic-a"
        prefetch={true}
      />
      <LinkAccordion
        href={`${ROOT}/dynamic-layout/b`}
        id="prefetch-layout-sharing-dynamic-b"
        prefetch={true}
      />
    </main>
  );
}
