export default function EncodedIsrDynamicPage({ slug }: { slug: string }) {
  return <p data-testid="encoded-isr">{`dynamic encoded-isr ${slug}`}</p>;
}

export function getStaticProps({ params }: { params: { slug: string } }) {
  // The literal `target` page owns this pathname.
  if (params.slug === "target") return { notFound: true, revalidate: 60 };
  // pages/404.tsx then sets the same cookie as middleware.ts on `?mwd`.
  if (params.slug === "not-found-set-cookie" || params.slug === "not-found-append-cookie") {
    return { notFound: true };
  }
  return { props: { slug: params.slug }, revalidate: 60 };
}

export function getStaticPaths() {
  return { paths: [], fallback: "blocking" };
}
