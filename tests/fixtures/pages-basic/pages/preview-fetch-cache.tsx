import type { GetServerSidePropsContext } from "next";

export async function getServerSideProps({ query }: GetServerSidePropsContext) {
  const res = await fetch(String(query.upstream), { next: { revalidate: false } });
  return { props: { token: await res.text() } };
}

export default function PreviewFetchCachePage({ token }: { token: string }) {
  return <p id="token">{token}</p>;
}
