import { useRouter } from "next/router";

export default function NotFoundPage({ renderedAt }: { renderedAt: number }) {
  const router = useRouter();
  return (
    <>
      <h1>404 - Page Not Found</h1>
      {/* The shared /404 document renders "/404"; the browser router then
          publishes the visited URL, so the text intentionally differs. */}
      <p id="as-path" suppressHydrationWarning>
        {router.asPath}
      </p>
      <p id="rendered-at">{renderedAt}</p>
    </>
  );
}

export function getStaticProps() {
  return { props: { renderedAt: Date.now() }, revalidate: 1 };
}
