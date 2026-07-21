export async function getServerSideProps() {
  return { props: {} };
}

export default function ExistsButNotRoutedPage() {
  return <p id="pages-page">This Pages route should be rewritten by middleware.</p>;
}
