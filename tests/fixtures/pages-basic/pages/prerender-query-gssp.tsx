import { useRouter } from "next/router";

export async function getServerSideProps({
  res,
}: {
  res: { setHeader(name: string, value: string): void };
}) {
  res.setHeader("X-Vinext-Resolved-Query", JSON.stringify({ spoofed: "user" }));
  return { props: {} };
}

export default function PrerenderQueryGssp() {
  return <pre id="query">{JSON.stringify(useRouter().query)}</pre>;
}
