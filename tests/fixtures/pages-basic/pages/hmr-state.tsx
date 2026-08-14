import Head from "next/head";
import { useState } from "react";

export default function HmrStatePage() {
  const [count, setCount] = useState(0);
  return (
    <>
      <Head>
        <meta name="hmr-head" content="Head version one" />
      </Head>
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
