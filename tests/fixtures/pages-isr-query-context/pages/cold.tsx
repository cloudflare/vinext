import { useRouter } from "next/router";

export default function ColdIsrPage() {
  const router = useRouter();
  return (
    <main>
      <p id="query">{JSON.stringify(router.query)}</p>
      <p id="as-path">{router.asPath}</p>
    </main>
  );
}

export function getStaticProps() {
  return { props: {}, revalidate: 1 };
}
