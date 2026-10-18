'use client';

import {usePathname} from '@/i18n/navigation';

export default function UnlocalizedPathname() {
  return <p data-testid="UnlocalizedPathname">{usePathname()}</p>;
}
