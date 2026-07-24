import type { NextPageContext } from "next";
import Head from "next/head";
import Link from "next/link";

import { ScreenArt } from "./screen-art";

const FaultShell = ({
  title,
  code,
  children,
}: {
  title: string;
  code: number;
  children?: React.ReactNode;
}) => (
  <>
    <Head>
      <title>{title}</title>
    </Head>
    <section data-testid={`fault-screen-${code}`}>
      <ScreenArt title={title} assetPath={`/artwork/fault-${code}.jpg`} />
      <h1>{title}</h1>
      {children}
      <p>
        <Link href="/">Go to the front page</Link>
      </p>
    </section>
  </>
);

export const MissingScreen = () => (
  <FaultShell title="We can't find that page" code={404}>
    <p>The page you asked for doesn't exist or has moved.</p>
  </FaultShell>
);

export const FaultScreen = () => (
  <FaultShell title="Something broke on our side" code={500}>
    <p>Please try again in a moment.</p>
  </FaultShell>
);

type CatchAllErrorProps = {
  statusCode?: number;
};

/**
 * The `_error` page component. Carries the classic pages-router
 * getInitialProps contract for error pages: the status code is derived from
 * the response (SSR) or the propagated error (client).
 */
export const CatchAllErrorScreen = ({ statusCode }: CatchAllErrorProps) => {
  if (statusCode === 404) {
    return <MissingScreen />;
  }
  return (
    <FaultShell
      title={`Application fault${statusCode ? ` (${statusCode})` : ""}`}
      code={statusCode ?? 500}
    >
      <p>An unexpected application fault occurred.</p>
    </FaultShell>
  );
};

CatchAllErrorScreen.getInitialProps = ({
  res,
  err,
}: NextPageContext): CatchAllErrorProps => {
  const statusCode = res ? res.statusCode : err ? (err.statusCode ?? 500) : 404;
  return { statusCode };
};
