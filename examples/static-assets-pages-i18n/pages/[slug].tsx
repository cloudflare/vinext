import type { GetStaticPropsContext } from "next";

export function getStaticPaths() {
  return {
    paths:
      process.env.VINEXT_PRERENDER === "1"
        ? ["en", "fr"].map((slug) => ({ params: { slug }, locale: "en" }))
        : [],
    fallback: false,
  };
}

export function getStaticProps({ params }: GetStaticPropsContext) {
  if (params?.slug === "fr") {
    return { redirect: { destination: "/posts/first/?from=default-fr", permanent: false } };
  }
  return { notFound: true };
}

export default function Page() {
  return null;
}
