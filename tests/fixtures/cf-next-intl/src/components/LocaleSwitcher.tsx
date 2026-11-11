import {Locale, useLocale, useTranslations} from 'next-intl';
import {Link} from '@/i18n/navigation';

export default function LocaleSwitcher() {
  const t = useTranslations('LocaleSwitcher');

  const locale = useLocale();
  const locales: Array<Locale> = ['en', 'de', 'es', 'ja', 'nl'];
  const otherLocales = locales.filter((cur) => cur !== locale);

  return (
    <ul>
      {otherLocales.map((otherLocale) => (
        <li key={otherLocale}>
          <Link href="/" locale={otherLocale}>
            {t('switchLocale', {locale: otherLocale})}
          </Link>
        </li>
      ))}
    </ul>
  );
}
