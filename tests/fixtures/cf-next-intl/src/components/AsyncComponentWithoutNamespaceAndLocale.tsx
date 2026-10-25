import {getLocale, getTranslations} from 'next-intl/server';

export default async function AsyncComponentWithoutNamespaceAndLocale() {
  const locale = await getLocale();
  const t = await getTranslations({locale});

  return (
    <div data-testid="AsyncComponentWithoutNamespaceAndLocale">
      {t('AsyncComponent.basic')}
    </div>
  );
}

export async function TypeTest() {
  const locale = await getLocale();
  const t = await getTranslations({locale});

  // @ts-expect-error
  t('AsyncComponent.unknown');
}
