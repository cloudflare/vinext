export default function BasePathRedirectPage() {
  return null;
}

export function getStaticPaths() {
  return { paths: [], fallback: "blocking" as const };
}

export function getStaticProps({ params }: { params?: { slug?: string } }) {
  return {
    redirect: {
      destination: "/hello",
      permanent: true,
      ...(params?.slug === "no-base" ? { basePath: false } : {}),
    },
    revalidate: 60,
  };
}
