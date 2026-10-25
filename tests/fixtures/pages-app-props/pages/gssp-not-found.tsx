// The custom App sets a public Cache-Control while rendering this notFound.
export function getServerSideProps() {
  return { notFound: true };
}

export default function GsspNotFoundPage() {
  return <div id="page-content">never rendered</div>;
}
