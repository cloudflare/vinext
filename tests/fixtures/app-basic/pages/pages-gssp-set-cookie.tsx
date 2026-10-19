import type { GetServerSideProps } from "next";

// middleware.ts sets its own cookie here. Next.js keeps it ahead of
// getServerSideProps' setHeader("Set-Cookie") and dedupes it against them.
export const getServerSideProps: GetServerSideProps = async ({ query, res }) => {
  res.setHeader("Set-Cookie", query.same ? ["mw=1; Path=/", "h=1; Path=/"] : "h=1; Path=/");
  return { props: {} };
};

export default function PagesGsspSetCookie() {
  return <div>pages gssp set-cookie</div>;
}
