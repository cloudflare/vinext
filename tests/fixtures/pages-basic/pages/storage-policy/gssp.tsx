import type { GetServerSidePropsContext } from "next";
export function getServerSideProps({ res }: GetServerSidePropsContext) {
  res.setHeader("Cache-Control", "public, max-age=3600");
  return { props: { renderId: crypto.randomUUID() } };
}
export default function Page({ renderId }: { renderId: string }) {
  return <div data-testid="storage-render-id">{renderId}</div>;
}
