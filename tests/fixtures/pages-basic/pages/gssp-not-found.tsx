import type { GetServerSideProps } from "next";

export default function GsspNotFound() {
  return <p>visible page</p>;
}

export const getServerSideProps: GetServerSideProps = async ({ query }) => {
  return query.hiding === "true" ? { notFound: true } : { props: {} };
};
