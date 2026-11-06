'use client';

import {useRouter} from '@/i18n/navigation';

export default function ClientRouter() {
  const router = useRouter();

  function onClick() {
    router.push('/nested');
  }

  return (
    <button data-testid="ClientRouter-link" onClick={onClick} type="button">
      Go to nested page
    </button>
  );
}
