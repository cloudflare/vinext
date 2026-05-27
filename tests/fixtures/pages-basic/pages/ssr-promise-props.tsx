interface SSRPromisePropsPageProps {
  hello: string;
  count: number;
}

export default function SSRPromisePropsPage({ hello, count }: SSRPromisePropsPageProps) {
  return (
    <div>
      <h1>SSR Promise Props</h1>
      <p data-testid="hello">{hello}</p>
      <p data-testid="count">count: {count}</p>
    </div>
  );
}

export function getServerSideProps() {
  // Next.js explicitly supports a Promise value for `props`. vinext must
  // await it before serialising — otherwise pageProps is empty.
  return {
    props: Promise.resolve({ hello: "world", count: 42 }),
  };
}
