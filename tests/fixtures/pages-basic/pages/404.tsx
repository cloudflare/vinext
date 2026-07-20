export default function Custom404({ viewer }: { viewer?: string }) {
  return (
    <div>
      <h1 data-testid="error-title">404 - Page Not Found</h1>
      <p data-testid="error-message">Sorry, the page you are looking for does not exist.</p>
      <p id="not-found-viewer">viewer: {viewer ?? "anonymous"}</p>
    </div>
  );
}

Custom404.getInitialProps = ({ req }: { req?: { headers?: { [key: string]: unknown } } }) => ({
  viewer: typeof req?.headers?.["x-viewer"] === "string" ? req.headers["x-viewer"] : "anonymous",
});
