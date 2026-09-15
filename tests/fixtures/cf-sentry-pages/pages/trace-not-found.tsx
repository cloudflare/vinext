import type { GetServerSideProps } from "next";

export const getServerSideProps: GetServerSideProps = async () => ({ notFound: true });

export default function TraceNotFoundPage() {
  return null;
}
