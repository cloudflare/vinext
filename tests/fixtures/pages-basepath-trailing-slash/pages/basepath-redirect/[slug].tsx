export default function BasePathRedirectPage() {
  return null;
}

export function getStaticPaths() {
  return { paths: [], fallback: "blocking" as const };
}

export function getStaticProps({ params }: { params?: { slug?: string } }) {
  const destination =
    params?.slug === "slashes"
      ? "/hello//world\\deep?keep=//query\\value"
      : params?.slug === "external"
        ? "https://example.com/a//b\\c?keep=//query\\value"
        : "/hello";
  return {
    redirect: {
      destination,
      permanent: true,
      ...(params?.slug === "no-base" ? { basePath: false } : {}),
    },
    revalidate: 60,
  };
}
