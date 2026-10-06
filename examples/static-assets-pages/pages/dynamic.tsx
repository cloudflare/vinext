import type { GetServerSidePropsContext } from "next";

export function getServerSideProps({ query, res }: GetServerSidePropsContext) {
  if (query.fail === "1") throw new Error("Expected fixture render failure");
  if (query.missing === "1") {
    res.setHeader("Set-Cookie", "session=expired; Path=/");
    res.setHeader("X-Not-Found-Source", "dynamic-page");
    return { notFound: true };
  }
  return { props: { generation: crypto.randomUUID() } };
}

export default function Dynamic({ generation }: { generation: string }) {
  return <p id="generation">{generation}</p>;
}
