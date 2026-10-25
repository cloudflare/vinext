import {ImageResponse} from 'next/og';
import {Locale} from 'next-intl';
import {getTranslations} from 'next-intl/server';

// vinext: upstream calls `sharp.unblock(...)` here to work around a Next.js
// libvips issue (vercel/next.js#96612). sharp can't run on Workers and the
// workaround doesn't apply to vinext, so it's dropped.
export default async function Image({
  params
}: {
  params: Promise<{locale: string}>;
}) {
  const {locale} = await params;
  const t = await getTranslations({
    namespace: 'OpenGraph',
    locale: locale as Locale
  });
  return new ImageResponse(<div style={{fontSize: 128}}>{t('title')}</div>);
}
