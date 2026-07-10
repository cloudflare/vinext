export function getStaticProps() {
  return {
    props: { token: crypto.randomUUID() },
    revalidate: 3600,
  };
}

export default function RevalidateTarget({ token }: { token: string }) {
  return <p id="revalidate-token">{token}</p>;
}
