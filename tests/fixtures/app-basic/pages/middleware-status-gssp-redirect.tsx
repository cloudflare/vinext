import type { GetServerSideProps } from "next";

// Reached through a middleware rewrite that sets status 404. The redirect
// getServerSideProps returns owns the response status, as in Next.js.
export default function MiddlewareStatusGsspRedirectPage() {
  return null;
}

export const getServerSideProps: GetServerSideProps = async () => ({
  redirect: { destination: "/about", permanent: false },
});
