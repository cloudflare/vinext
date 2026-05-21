// Regression fixture for #1354: pages may declare `getServerSideProps` as a
// local `const` and re-export it via `export { getServerSideProps }`. The
// build pipeline must not redeclare the identifier when stripping server
// exports from the client bundle.
//
// Ported from Next.js: test/e2e/getserversideprops/app/pages/refresh.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/getserversideprops/app/pages/refresh.js
interface Props {
  message: string;
}

const getServerSideProps = async () => {
  return {
    props: {
      message: "Hello from named-export gSSP",
    },
  };
};

function GsspNamedExportPage({ message }: Props) {
  return (
    <div>
      <h1>gSSP via named export</h1>
      <p data-testid="message">{message}</p>
    </div>
  );
}

export default GsspNamedExportPage;
export { getServerSideProps };
