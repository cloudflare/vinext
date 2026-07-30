export async function getServerSideProps() {
  throw new Error("KABOOM!");
}

export default function ErrorRoute() {
  return null;
}
