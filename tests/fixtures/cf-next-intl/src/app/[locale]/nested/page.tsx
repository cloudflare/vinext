import {useTranslations} from 'next-intl';
import {getTranslations} from 'next-intl/server';
import PageLayout from '../../../components/PageLayout';
import UnlocalizedPathname from './UnlocalizedPathname';

export async function generateMetadata() {
  const t = await getTranslations('Nested');
  return {
    title: t('title')
  };
}

export default function Nested() {
  const t = useTranslations('Nested');

  return (
    <PageLayout title={t('title')}>
      <p>{t('description')}</p>
      <UnlocalizedPathname />
    </PageLayout>
  );
}
