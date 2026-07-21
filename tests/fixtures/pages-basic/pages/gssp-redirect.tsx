// A getServerSideProps page that always redirects. On a client-side navigation
// the data endpoint replies 200 with `pageProps.__N_REDIRECT`, and the client
// router re-enters a fresh navigation to the destination — which supersedes
// (cancels) this navigation so this page never commits.
//
// Mirrors Next.js: test/e2e/getserversideprops/test/index.test.ts
// "should not trigger an error when a data request is cancelled due to another
// navigation".

import type { GetServerSideProps } from "next";

export default function GsspRedirectPage() {
  return <h1 data-testid="redirect-page">Redirect Page</h1>;
}

export const getServerSideProps: GetServerSideProps = async ({ query }) => {
  // Small delay so the navigation is observably in-flight, matching the
  // "slow nav cancelled by a redirect" shape of the upstream test.
  await new Promise((resolve) => setTimeout(resolve, 200));
  return {
    redirect: {
      destination: typeof query.next === "string" ? query.next : "/gssp-redirect-target",
      permanent: false,
    },
  };
};
