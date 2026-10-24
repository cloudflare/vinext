import Link from "next/link";
import { LinkAccordion } from "./components/link-accordion";

const ROOT = "/nextjs-compat/segment-cache-dynamic-params";

export default function Page() {
  return (
    <main>
      <h1 id="segment-cache-dynamic-params-home">Prefetch closed parameters</h1>
      <LinkAccordion href={`${ROOT}/products/allowed`}>Allowed product</LinkAccordion>
      <LinkAccordion href={`${ROOT}/products/rejected`}>Rejected product</LinkAccordion>
      <Link href={`${ROOT}/products/rejected`} prefetch={false} id="navigate-rejected">
        Navigate without prefetching
      </Link>
    </main>
  );
}
