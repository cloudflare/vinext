'use client';

import { changeSessionAction } from '#/app/private-cache/actions';
import Button from '#/ui/button';
import { useState, useTransition } from 'react';

export default function SessionButton() {
  const [isPending, startTransition] = useTransition();
  const [sessionChanged, setSessionChanged] = useState(false);

  return (
    <Button
      kind="default"
      onClick={() => {
        startTransition(async () => {
          await changeSessionAction();
          setSessionChanged(true);
          setTimeout(() => setSessionChanged(false), 2000);
        });
      }}
      disabled={isPending}
    >
      {isPending
        ? 'Changing Session...'
        : sessionChanged
          ? 'Session Changed!'
          : 'Change Session'}
    </Button>
  );
}
