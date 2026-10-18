import {Metadata} from 'next';
import {useTranslations} from 'next-intl';
import {getLocale} from 'next-intl/server';
import {use} from 'react';
import {getPathname} from '@/i18n/navigation';

export async function generateMetadata({
  params
}: PageProps<'/[locale]/news/[articleId]'>): Promise<Metadata> {
  const {articleId} = await params;
  const locale = await getLocale();

  return {
    alternates: {
      canonical: getPathname({
        href: {
          pathname: '/news/[articleId]',
          params: {articleId}
        },
        locale
      })
    }
  };
}

export default function NewsArticle(
  props: PageProps<'/[locale]/news/[articleId]'>
) {
  const {articleId} = use(props.params);
  const v2 = use(props.searchParams).v2 === 'true';
  const t = useTranslations('NewsArticle');
  return (
    <h1>
      {t('title', {articleId})}
      {v2 && <>(v2)</>}
    </h1>
  );
}
