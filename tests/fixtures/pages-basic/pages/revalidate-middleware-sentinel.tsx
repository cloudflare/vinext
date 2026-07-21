export async function getStaticProps() {
  return { props: { ok: true }, revalidate: 3600 };
}

export default function RevalidateMiddlewareSentinel({ ok }: { ok: boolean }) {
  return <p>{ok ? "revalidation target" : "unexpected"}</p>;
}
