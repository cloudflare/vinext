// Regression fixture for the deploy-suite test:
// .nextjs-ref/test/e2e/app-dir/pages-to-app-routing/pages-to-app-routing.test.ts
//
// A dynamic Pages Router page with GSSP that renders a Link to an App Router
// destination (/about). Clicking the link must trigger a hard navigation to
// the App Router page — not an in-place SPA swap — because the Pages Router
// client recognises /about as an App Router route via the prefetch manifest.
import Link from "next/link";

type Props = { params: Record<string, string> };

export async function getServerSideProps({ params }: { params: Record<string, string> }) {
  return { props: { params } };
}

export default function PagesToAppPage({ params }: Props) {
  return (
    <>
      <h1 id="params">Params: {JSON.stringify(params)}</h1>
      <Link id="to-about-link" href="/about">
        To About
      </Link>
      <Link id="to-rewritten-about-link" href="/rewrite-about">
        To Rewritten About
      </Link>
      <Link id="to-middleware-rewritten-existing-page-link" href="/exists-but-not-routed">
        To Middleware-Rewritten Existing Page
      </Link>
    </>
  );
}
