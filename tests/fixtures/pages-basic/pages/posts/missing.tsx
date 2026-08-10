import React from "react";

// This page simulates a missing resource by returning notFound from getServerSideProps
export default function MissingPost() {
  return <div>This should never render</div>;
}

export async function getServerSideProps({
  res,
}: {
  res: { setHeader(name: string, value: string | string[]): void };
}) {
  // Next.js retains this ServerResponse while rendering the 404 page.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/route-modules/pages/pages-handler.ts
  res.setHeader("Content-Length", "1");
  res.setHeader("Content-Type", "application/vnd.vinext.not-found+html");
  res.setHeader("Set-Cookie", ["missing=one; Path=/", "missing=two; Path=/"]);
  res.setHeader("Surrogate-Control", "max-age=600s, delta=noop");
  res.setHeader("Transfer-Encoding", "identity");
  return {
    notFound: true,
  };
}
