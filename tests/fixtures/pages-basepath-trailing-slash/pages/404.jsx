import { useRouter } from "next/router";

export default function NotFound() {
  const router = useRouter();
  return (
    <>
      <h1>404 - Page Not Found</h1>
      {/* The shared /404 document renders "/404/"; the browser router then
          publishes the visited URL, so the text intentionally differs. */}
      <p id="as-path" suppressHydrationWarning>
        {router.asPath}
      </p>
    </>
  );
}

export function getStaticProps() {
  return { props: {}, revalidate: 60 };
}
