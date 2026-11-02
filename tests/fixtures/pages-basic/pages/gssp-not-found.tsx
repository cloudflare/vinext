import type { GetServerSideProps } from "next";

export default function GsspNotFound() {
  return <p>visible page</p>;
}

export const getServerSideProps: GetServerSideProps = async ({ query, res }) => {
  // `?own-cache-control` sets the handler's own policy, which Next.js keeps
  // over a middleware or next.config Cache-Control.
  if (query["own-cache-control"] !== undefined) res.setHeader("Cache-Control", "s-maxage=5");
  return query.hiding === "true" ? { notFound: true } : { props: {} };
};
