import type { NextPageContext } from "next";

function HostEchoInitial({ host }: { host: string }) {
  return <output data-testid="host">{host}</output>;
}

HostEchoInitial.getInitialProps = ({ req, res }: NextPageContext) => {
  res?.setHeader("CDN-Cache-Control", "public, s-maxage=60");
  return { host: req?.headers.host ?? "" };
};

export default HostEchoInitial;
