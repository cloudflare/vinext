import type { GetServerSideProps } from "next";

export const getServerSideProps: GetServerSideProps = async ({ query }) => ({
  redirect: {
    destination: typeof query.next === "string" ? query.next : "/",
    permanent: false,
  },
});

export default function DataRedirectPage() {
  return null;
}
