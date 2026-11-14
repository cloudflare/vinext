export function getStaticProps() {
  return { props: { message: "fetched at build time" } };
}

export default function NotFound({ message }: { message: string }) {
  return (
    <div>
      <h1>PAGES ROUTER - 404 PAGE</h1>
      <p>{message}</p>
    </div>
  );
}
