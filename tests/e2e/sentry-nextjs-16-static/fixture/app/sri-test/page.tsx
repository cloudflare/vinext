'use client';

import Link from 'next/link';
import { useState } from 'react';

export default function SriTestPage() {
  const [count, setCount] = useState(0);

  return (
    <div>
      <h1 id="sri-test-heading">SRI Test Page</h1>
      <button id="counter-button" onClick={() => setCount(c => c + 1)}>
        Count: {count}
      </button>
      <Link href="/sri-test/target" id="navigate-link">
        Go to target
      </Link>
    </div>
  );
}
