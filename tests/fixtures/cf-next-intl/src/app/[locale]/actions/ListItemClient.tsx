'use client';

import {useTranslations} from 'next-intl';

export default function ListItemClient({id}: {id: number}) {
  const t = useTranslations('ServerActions');
  return t('item', {id: String(id)});
}
