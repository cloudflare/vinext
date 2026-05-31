// Regression fixture for issue #1458: when getServerSideProps throws, the
// server should render the user's custom pages/500.tsx (or _error fallback)
// rather than collapsing the request into a plain "Internal Server Error".
export default function GsspThrow() {
  return <div>This page never renders.</div>;
}

export async function getServerSideProps() {
  throw new Error("intentional gSSP throw — fixture for vinext#1458");
}
