export default function GsspNonJsonPage({ time }: { time: Date }) {
  return <p data-testid="gssp-non-json">hello {time.toString()}</p>;
}

export async function getServerSideProps() {
  return {
    props: { time: new Date(0) },
  };
}
