import { useEffect, useState } from "react";
import { useRouter } from "next/router";

export default function NotFoundPage({ renderedAt }: { renderedAt: number }) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <main>
      <h1>Shared ISR 404</h1>
      {/* The shared /404 document renders "/404"; the browser router then
          publishes the visited URL, so the text intentionally differs. */}
      <p id="as-path" suppressHydrationWarning>
        {router.asPath}
      </p>
      <p id="client-as-path">{mounted ? router.asPath : ""}</p>
      <p id="rendered-at">{renderedAt}</p>
    </main>
  );
}

export function getStaticProps() {
  return { props: { renderedAt: Date.now() }, revalidate: 1 };
}
