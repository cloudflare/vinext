'use client';

import React from 'react';

export function ClickCounter() {
  const [count, setCount] = React.useState(0);

  return (
    <button
      onClick={() => setCount(count + 1)}
      className="rounded-md bg-gray-700 px-3 py-1 text-sm font-semibold whitespace-nowrap text-gray-100 tabular-nums hover:bg-gray-500 hover:text-white"
    >
      {count} Clicks
    </button>
  );
}
