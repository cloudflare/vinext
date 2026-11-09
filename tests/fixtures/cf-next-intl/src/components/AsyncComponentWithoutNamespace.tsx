import {getTranslations} from 'next-intl/server';

export default async function AsyncComponentWithoutNamespace() {
  const t = await getTranslations();

  return (
    <div data-testid="AsyncComponentWithoutNamespace">
      {t('AsyncComponent.basic')}
    </div>
  );
}

export async function TypeTest() {
  const t = await getTranslations();

  // @ts-expect-error
  t('AsyncComponent.unknown');
}
