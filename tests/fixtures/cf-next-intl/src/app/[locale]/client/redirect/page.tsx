'use client';

import {useLocale} from 'next-intl';
import {redirect} from '@/i18n/navigation';

export default function ClientRedirectPage() {
  const locale = useLocale();
  redirect({href: '/client', locale});
}
