// Rendered per request, so the 404 page is the build's only prerendered page.
export function getServerSideProps() {
  return { props: {} };
}

export default function Home() {
  return <p>home</p>;
}
