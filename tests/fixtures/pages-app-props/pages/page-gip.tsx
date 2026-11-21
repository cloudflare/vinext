function PageGetInitialProps({ fromPage }: { fromPage: string }) {
  return <div id="page-content">{fromPage}</div>;
}

PageGetInitialProps.getInitialProps = async ({
  query,
  res,
}: {
  query: { cacheControl?: string };
  res?: { setHeader(name: string, value: string | string[]): void };
}) => {
  // Used by tests/pages-router.test.ts: a raw `[]` Cache-Control counts as set
  // and an empty string does not, as in Next.js.
  if (res && query.cacheControl === "array") res.setHeader("Cache-Control", []);
  if (res && query.cacheControl === "empty") res.setHeader("Cache-Control", "");
  return { fromPage: "from-page" };
};

export default PageGetInitialProps;
