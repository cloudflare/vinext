import {Metadata} from 'next';
import {Inter} from 'next/font/google';
import {NextIntlClientProvider} from 'next-intl';
import {
  getFormatter,
  getLocale,
  getNow,
  getTimeZone,
  getTranslations
} from 'next-intl/server';
import Navigation from '../../components/Navigation';

const inter = Inter({subsets: ['latin']});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('LocaleLayout');
  const formatter = await getFormatter();
  const now = await getNow();
  const timeZone = await getTimeZone();

  const base = new URL('http://localhost:3000');
  if (process.env.NEXT_PUBLIC_USE_CASE === 'base-path') {
    base.pathname = '/base/path';
  }

  return {
    metadataBase: base,
    title: t('title'),
    description: t('description'),
    other: {
      currentYear: formatter.dateTime(now, {year: 'numeric'}),
      timeZone
    }
  };
}

export default async function LocaleLayout({
  children
}: LayoutProps<'/[locale]'>) {
  const locale = await getLocale();

  return (
    <html className={inter.className} lang={locale}>
      <body>
        <div
          style={{
            padding: 24,
            fontFamily: 'system-ui, sans-serif',
            lineHeight: 1.5
          }}
        >
          <NextIntlClientProvider>
            <Navigation />
            {children}
          </NextIntlClientProvider>
        </div>
      </body>
    </html>
  );
}
