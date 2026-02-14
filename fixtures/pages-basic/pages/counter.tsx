import { useState } from "react";
import Head from "next/head";
import Link from "next/link";

export default function CounterPage() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <Head>
        <title>Counter - vinext</title>
      </Head>
      <h1>Counter Page</h1>
      <p data-testid="count">Count: {count}</p>
      <button data-testid="increment" onClick={() => setCount((c) => c + 1)}>
        Increment
      </button>
      <button data-testid="decrement" onClick={() => setCount((c) => c - 1)}>
        Decrement
      </button>
      <Link href="/">Back to Home</Link>
    </div>
  );
}
