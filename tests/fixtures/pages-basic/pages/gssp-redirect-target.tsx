// Destination of /gssp-redirect's getServerSideProps redirect. The cancellation
// test asserts navigation lands here ("a normal page") instead of committing
// the intermediate Redirect Page.

export default function GsspRedirectTargetPage() {
  return <p data-testid="normal-text">a normal page</p>;
}
