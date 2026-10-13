import {getLocale, getTranslations} from 'next-intl/server';

export default async function AsyncComponentWithNamespaceAndLocale() {
  const locale = await getLocale();
  const t = await getTranslations({locale, namespace: 'AsyncComponent'});

  return (
    <div data-testid="AsyncComponentWithNamespaceAndLocale">
      {t('basic')}
    </div>
  );
}

export async function TypeTest() {
  const locale = await getLocale();
  const t = await getTranslations({locale});

  // @ts-expect-error
  await getTranslations({locale, namespace: 'Unknown'});

  // @ts-expect-error
  t('AsyncComponent.unknown');
}
