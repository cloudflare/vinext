'use client';

import Link from 'next/link';
import { useState } from 'react';

export default function SriTestTargetPage() {
  const [clicked, setClicked] = useState(false);

  return (
    <div>
      <h1 id="sri-target-heading">SRI Target Page</h1>
      <button id="target-button" onClick={() => setClicked(true)}>
        {clicked ? 'Clicked!' : 'Click me'}
      </button>
      <Link href="/sri-test" id="back-link">
        Go back
      </Link>
    </div>
  );
}
