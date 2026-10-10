import { useRouter } from "next/router";

export default function ErrorPage() {
  const router = useRouter();
  return (
    <main>
      <h1>Shared ISR 500</h1>
      <p id="as-path" suppressHydrationWarning>
        {router.asPath}
      </p>
    </main>
  );
}

export function getStaticProps() {
  return { props: {}, revalidate: 1 };
}
