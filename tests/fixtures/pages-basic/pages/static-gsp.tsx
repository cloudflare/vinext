import { useRouter } from "next/router";

type StaticGspProps = {
  message: string;
};

export function getStaticProps() {
  return {
    props: {
      message: "Hello from static GSP",
    },
  };
}

export default function StaticGsp({ message }: StaticGspProps) {
  const router = useRouter();
  return (
    <>
      <p data-testid="message">{message}</p>
      <p data-testid="as-path">{router.asPath}</p>
      <p data-testid="query">{JSON.stringify(router.query)}</p>
    </>
  );
}
