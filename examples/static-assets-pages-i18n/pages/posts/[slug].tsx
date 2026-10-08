import type { GetStaticPathsContext, GetStaticPropsContext } from "next";

export function getStaticPaths({ locales, defaultLocale }: GetStaticPathsContext) {
  if (process.env.VINEXT_PRERENDER !== "1") return { paths: [], fallback: false };
  return {
    paths:
      defaultLocale === "en"
        ? [
            ...(locales ?? []).map((locale) => ({ params: { slug: "first" }, locale })),
            "/fr/posts/string",
            { params: { slug: "french-only" }, locale: "fr" },
          ]
        : [],
    fallback: false,
  };
}

export function getStaticProps({ locale }: GetStaticPropsContext) {
  return {
    props: { locale, source: process.env.VINEXT_PRERENDER === "1" ? "build-time" : "runtime" },
    revalidate: 1,
  };
}

export default function Post({ locale, source }: { locale: string; source: string }) {
  return (
    <main>
      <p id="locale">{locale}</p>
      <p id="render-source">{source}</p>
    </main>
  );
}
