import localFont from "next/font/local";

const font = localFont({ src: "../fonts/font-error.woff2" });

function ErrorPage({ statusCode }: { statusCode?: number }) {
  return <h1 className={font.className}>Error {statusCode}</h1>;
}

ErrorPage.getInitialProps = ({
  res,
  err,
}: {
  res?: { statusCode: number };
  err?: { statusCode?: number };
}) => ({
  statusCode: res?.statusCode ?? err?.statusCode ?? 404,
});

export default ErrorPage;
