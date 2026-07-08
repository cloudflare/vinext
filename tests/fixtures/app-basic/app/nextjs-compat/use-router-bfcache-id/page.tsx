import { LinkAccordion } from "./components/link-accordion";

const base = "/nextjs-compat/use-router-bfcache-id";

export default function Page() {
  return (
    <main>
      <h1>useRouter bfcacheId</h1>
      <ul>
        <li>
          <LinkAccordion href={`${base}/x/1`}>/x/1</LinkAccordion>
        </li>
        <li>
          <LinkAccordion href={`${base}/x/2`}>/x/2</LinkAccordion>
        </li>
        <li>
          <LinkAccordion href={`${base}/y/1`}>/y/1</LinkAccordion>
        </li>
      </ul>
    </main>
  );
}
