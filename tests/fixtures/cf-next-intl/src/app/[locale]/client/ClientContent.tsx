'use client';

import {useLocale, useNow, useTimeZone} from 'next-intl';
import {Link, usePathname, useRouter} from '@/i18n/navigation';

export default function ClientContent() {
  const now = useNow();
  const timeZone = useTimeZone();
  const locale = useLocale();
  const router = useRouter();

  return (
    <>
      <p data-testid="NowFromClient">{now.toISOString()}</p>
      <p>
        <Link href="/">Go to home</Link>
      </p>
      <p>
        <Link href="/nested">Go to nested (with link)</Link>
      </p>
      <p>
        <button onClick={() => router.push('/nested')}>
          Go to nested (with router)
        </button>
      </p>
      <p data-testid="UnlocalizedPathname">{usePathname()}</p>
      <p data-testid="TimeZone">{timeZone}</p>
      <p data-testid="Locale">{locale}</p>
      <button
        onClick={() =>
          router.replace('/client', {locale: locale === 'en' ? 'de' : 'en'})
        }
      >
        Switch to {locale === 'en' ? 'de' : 'en'}
      </button>
    </>
  );
}
