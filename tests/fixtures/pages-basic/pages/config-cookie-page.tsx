// next.config.mjs adds a config Set-Cookie to this page, and middleware.ts sets
// its own cookie when `?middleware-cookie` is present.
export default function ConfigCookiePage() {
  return <p>config cookie page</p>;
}

export function getServerSideProps() {
  return { props: {} };
}
