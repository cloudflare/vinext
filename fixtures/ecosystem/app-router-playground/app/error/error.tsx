'use client';

import { Boundary } from '#/ui/boundary';
import Button from '#/ui/button';
import React from 'react';

export default function Error({ error, reset }: any) {
  React.useEffect(() => {
    console.log('logging error:', error);
  }, [error]);

  return (
    <Boundary label="error.tsx" color="red">
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold text-gray-300">Error</h1>
        <div className="text-sm text-gray-500">{error?.message}</div>
        <div className="flex">
          <Button onClick={() => reset()}>Try Again</Button>
        </div>
      </div>
    </Boundary>
  );
}
