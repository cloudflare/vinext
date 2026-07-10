import { useRouter } from "next/router";

export default function DynamicIsrPage() {
  const router = useRouter();
  return (
    <main>
      <p id="query">{JSON.stringify(router.query)}</p>
      <p id="as-path">{router.asPath}</p>
    </main>
  );
}

export function getStaticPaths() {
  return { paths: [{ params: { slug: "known" } }], fallback: "blocking" };
}

export function getStaticProps() {
  return { props: {}, revalidate: 1 };
}
