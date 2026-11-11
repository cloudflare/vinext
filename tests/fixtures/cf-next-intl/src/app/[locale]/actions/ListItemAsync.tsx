import {Locale} from 'next-intl';
import {getTranslations} from 'next-intl/server';

export default async function ListItemAsync({
  id,
  locale
}: {
  id: number;
  locale: Locale;
}) {
  const t = await getTranslations({namespace: 'ServerActions', locale});
  return t('item', {id: String(id)});
}
