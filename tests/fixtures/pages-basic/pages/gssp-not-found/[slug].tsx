import type { GetServerSideProps } from "next";

export default function DynamicGsspNotFound() {
  return <p>visible dynamic page</p>;
}

export const getServerSideProps: GetServerSideProps = async ({ query }) => {
  return query.hiding === "true" ? { notFound: true } : { props: {} };
};
