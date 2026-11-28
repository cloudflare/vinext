// Ported from Next.js: test/e2e/fallback-false-rewrite/pages/[slug].js
import { useRouter } from "next/router";

export const getStaticProps = () => ({ props: { world: "world" } });

export const getStaticPaths = () => ({
  paths: ["/first", "/second"],
  fallback: false,
});

export default function Page({ world }: { world: string }) {
  const router = useRouter();
  if (router.isFallback) throw new Error("should not have fallback");
  return (
    <>
      <p id="slug">hello {world}</p>
      <p id="query">{JSON.stringify(router.query)}</p>
    </>
  );
}
