import { useRouter } from "next/router";

export default function EncodedIsrStaticPage() {
  const { asPath } = useRouter();
  return <p data-testid="encoded-isr">{`static encoded-isr new at ${asPath}`}</p>;
}

export function getStaticProps() {
  return { props: {} };
}
