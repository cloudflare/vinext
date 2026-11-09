import {useTranslations} from 'next-intl';

export default function NewsArticle() {
  const t = useTranslations('JustIn');
  return <h1>{t('title')}</h1>;
}
