import type { GetStaticPaths, GetStaticProps, InferGetStaticPropsType } from "next";

export const getStaticPaths: GetStaticPaths = () => ({
  paths: [
    "first",
    "second",
    "café",
    "with space",
    "a/b",
    "a%2Fb",
    "a?b",
    "a#b",
    "a\\b",
    "%66irst",
  ].map((slug) => ({ params: { slug } })),
  fallback: "blocking",
});

export const getStaticProps: GetStaticProps<{
  slug: string;
  source: string;
  generation: string;
}> = ({ params, preview }) => ({
  props: {
    slug: String(params!.slug),
    source: preview ? "preview" : process.env.VINEXT_PRERENDER === "1" ? "build-time" : "runtime",
    generation: crypto.randomUUID(),
  },
  revalidate: 1,
});

export default function Post({
  slug,
  source,
  generation,
}: InferGetStaticPropsType<typeof getStaticProps>) {
  return (
    <main>
      <h1>Post: {slug}</h1>
      <p id="render-source">{source}</p>
      <p id="generation">{generation}</p>
    </main>
  );
}
