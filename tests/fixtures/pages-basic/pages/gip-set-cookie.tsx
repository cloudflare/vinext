import type { NextPageContext } from "next";

// middleware.ts sets the same cookie here on `?mwd`. Next.js runs one Set over
// it and getInitialProps' setHeader("Set-Cookie"), so it is sent once.
function GipSetCookie() {
  return <div>gip set-cookie</div>;
}

GipSetCookie.getInitialProps = ({ query, res }: NextPageContext) => {
  if (query.mwd !== undefined) res?.setHeader("Set-Cookie", ["d=1; Path=/", "d=1; Path=/"]);
  return {};
};

export default GipSetCookie;
