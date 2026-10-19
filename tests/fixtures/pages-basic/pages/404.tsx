export default function Custom404({ viewer }: { viewer?: string }) {
  return (
    <div>
      <h1 data-testid="error-title">404 - Page Not Found</h1>
      <p data-testid="error-message">Sorry, the page you are looking for does not exist.</p>
      <p id="not-found-viewer">viewer: {viewer ?? "anonymous"}</p>
    </div>
  );
}

Custom404.getInitialProps = ({
  asPath,
  req,
  res,
}: {
  asPath?: string;
  req?: { headers?: { [key: string]: unknown } };
  res?: {
    appendHeader(name: string, value: string): unknown;
    setHeader(name: string, value: string | string[]): unknown;
  };
}) => {
  // middleware.ts sets the same cookie on these paths with `?mwd`; Next.js
  // sends it once.
  if (
    asPath?.startsWith("/missing-set-cookie") ||
    asPath?.startsWith("/encoded-isr/not-found-set-cookie")
  ) {
    res?.setHeader("Set-Cookie", ["d=1; Path=/", "d=1; Path=/"]);
  }
  // A replacement keeps middleware's cookie first; an appended copy follows.
  if (asPath?.startsWith("/encoded-isr/not-found-append-cookie")) {
    res?.setHeader("Set-Cookie", "h=1; Path=/");
    res?.appendHeader("Set-Cookie", "d=1; Path=/");
  }
  return {
    viewer: typeof req?.headers?.["x-viewer"] === "string" ? req.headers["x-viewer"] : "anonymous",
  };
};
