// A getServerSideProps page that redirects to an EXTERNAL destination. On a
// client `_next/data` navigation the destination is carried verbatim in
// `pageProps.__N_REDIRECT`; the client router hard-navigates to it (it is not
// an internal path), so the destination must be preserved exactly.

export default function GsspRedirectExternalPage() {
  return <h1 data-testid="redirect-page">External Redirect Page</h1>;
}

export async function getServerSideProps() {
  return {
    redirect: {
      destination: "https://example.com/landing",
      permanent: false,
    },
  };
}
