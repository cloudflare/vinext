import Head from "next/head";
import { useEffect, useState } from "react";

function HmrHead() {
  return (
    <Head>
      <title>HMR title one</title>
      <meta name="hmr-head" content="Head version one" />
    </Head>
  );
}

export default function HmrStatePage() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const target = window as typeof window & { __HMR_EFFECT_COUNT__?: number };
    target.__HMR_EFFECT_COUNT__ = (target.__HMR_EFFECT_COUNT__ ?? 0) + 1;
  });
  return (
    <>
      <HmrHead key="head-instance-one" />
      <main>
        <h1 data-testid="version">Version one</h1>
        <p data-testid="count">Count: {count}</p>
        <button data-testid="increment" onClick={() => setCount((value) => value + 1)}>
          Increment
        </button>
      </main>
    </>
  );
}
