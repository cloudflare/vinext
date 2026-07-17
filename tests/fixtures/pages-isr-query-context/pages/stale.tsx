import { useParams } from "next/navigation";
import { useRouter } from "next/router";

export default function StaleIsrPage() {
  const router = useRouter();
  const params = useParams();
  return (
    <main>
      <p id="query">{JSON.stringify(router.query)}</p>
      <p id="as-path">{router.asPath}</p>
      <p id="ready">{String(router.isReady)}</p>
      <p id="navigation-params">{JSON.stringify(params)}</p>
    </main>
  );
}

export function getStaticProps() {
  return { props: {}, revalidate: 1 };
}
