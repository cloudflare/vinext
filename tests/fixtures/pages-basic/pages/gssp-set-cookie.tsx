import type { GetServerSideProps } from "next";

// middleware.ts sets its own cookie here on `?mwcookie`. Next.js keeps it
// ahead of getServerSideProps' setHeader("Set-Cookie") and dedupes the values.
export const getServerSideProps: GetServerSideProps = async ({ res, query }) => {
  res.setHeader("Set-Cookie", "dup" in query ? ["d=1; Path=/", "d=1; Path=/"] : "h=1; Path=/");
  return { props: {} };
};

export default function GsspSetCookie() {
  return <div>gssp set-cookie</div>;
}
