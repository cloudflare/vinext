import {NextIntlClientProvider, useNow, useTranslations} from 'next-intl';
import PageLayout from '../../../components/PageLayout';
import ClientContent from './ClientContent';
import DelayedServerContent from './DelayedServerContent';

export default function Client() {
  const t = useTranslations('Client');
  const now = useNow();

  return (
    <PageLayout title={t('title')}>
      <p>{t('description')}</p>
      <p data-testid="NowFromServer">{now.toISOString()}</p>
      <DelayedServerContent />
      <NextIntlClientProvider>
        <ClientContent />
      </NextIntlClientProvider>
    </PageLayout>
  );
}
