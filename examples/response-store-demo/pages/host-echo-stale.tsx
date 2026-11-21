import type { NextPageContext } from "next";

function HostEchoStale({ host, renderId }: { host: string; renderId: string }) {
  return (
    <main>
      <output data-testid="host">{host}</output>
      <output data-testid="render-id">{renderId}</output>
    </main>
  );
}

// Stored per host, as a CDN in front of Next.js stores it, and stale after a
// second, so a test can see a regeneration read the host it was filled on.
HostEchoStale.getInitialProps = ({ req, res }: NextPageContext) => {
  res?.setHeader("CDN-Cache-Control", "public, s-maxage=1, stale-while-revalidate=60");
  return { host: req?.headers.host ?? "", renderId: crypto.randomUUID() };
};

export default HostEchoStale;
